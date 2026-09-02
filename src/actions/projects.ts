'use server'

import { createClient } from '@/lib/supabase/server'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { decryptToken } from '@/lib/crypto'
import { deleteSharedPreview, sharedPreviewConfig } from '@/lib/preview'
import {
  getSelectableOwners,
  isOwnerAllowed,
  ownerTypeOf,
} from '@/lib/github/owners'
import { accountNeedsReconnect } from '@/lib/github/scopes'
import type { ProjectKind } from '@/lib/templates/project-files'

const activateProjectSchema = z.object({
  projectId: z.string().uuid(),
})

export async function activateProject(
  projectId: string,
): Promise<{ error?: string }> {
  const parsed = activateProjectSchema.safeParse({ projectId })
  if (!parsed.success) {
    return { error: 'ID de projeto inválido.' }
  }

  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) return { error: 'Não autorizado.' }

  // Verificar ownership (além do RLS)
  const { data: project } = await supabase
    .from('projects')
    .select('id')
    .eq('id', parsed.data.projectId)
    .eq('user_id', user.id)
    .single()

  if (!project) return { error: 'Projeto não encontrado.' }

  // Desativar todos os projetos do usuário
  const { error: deactivateError } = await supabase
    .from('projects')
    .update({ is_active: false })
    .eq('user_id', user.id)
    .neq('id', parsed.data.projectId)

  if (deactivateError) {
    return { error: 'Erro ao desativar projetos anteriores.' }
  }

  // Ativar o projeto selecionado
  const { error: activateError } = await supabase
    .from('projects')
    .update({ is_active: true })
    .eq('id', parsed.data.projectId)
    .eq('user_id', user.id)

  if (activateError) {
    return { error: 'Erro ao ativar projeto.' }
  }

  // Log de auditoria
  await supabase.from('audit_logs').insert({
    user_id: user.id,
    action: 'project.activate',
    resource_type: 'project',
    resource_id: parsed.data.projectId,
  })

  revalidatePath('/', 'layout')

  return {}
}

const createProjectSchema = z.object({
  name: z
    .string()
    .min(2)
    .max(50)
    .regex(/^[a-z0-9-]+$/, {
      message: 'Apenas letras minúsculas, números e hífens.',
    }),
  description: z.string().max(200).optional(),
  githubAccountId: z.string().uuid().optional(),
  supabaseAccountId: z.string().uuid().optional(),
  // Tipo de app, escolhido na criação. Decide a migration e os arquivos que o
  // scaffold gera. Padrão 'solo' — app com login e dados por usuário.
  kind: z.enum(['public', 'solo', 'team']).default('solo'),
})

export async function createProject(
  formData: z.infer<typeof createProjectSchema>,
): Promise<{ error?: string; projectId?: string }> {
  const parsed = createProjectSchema.safeParse(formData)
  if (!parsed.success) {
    const firstError = parsed.error.issues[0]
    return { error: firstError?.message ?? 'Dados inválidos.' }
  }

  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) return { error: 'Não autorizado.' }

  // Verificar ownership das contas
  if (parsed.data.githubAccountId) {
    const { data: ghAccount } = await supabase
      .from('github_accounts')
      .select('id')
      .eq('id', parsed.data.githubAccountId)
      .eq('user_id', user.id)
      .single()
    if (!ghAccount) return { error: 'Conta GitHub inválida.' }
  }

  if (parsed.data.supabaseAccountId) {
    const { data: sbAccount } = await supabase
      .from('supabase_accounts')
      .select('id')
      .eq('id', parsed.data.supabaseAccountId)
      .eq('user_id', user.id)
      .single()
    if (!sbAccount) return { error: 'Conta Supabase inválida.' }
  }

  // Criar projeto
  const { data: project, error } = await supabase
    .from('projects')
    .insert({
      user_id: user.id,
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      kind: parsed.data.kind,
      github_account_id: parsed.data.githubAccountId ?? null,
      supabase_account_id: parsed.data.supabaseAccountId ?? null,
      active_mcp: 'antigravity',
      active_branch: 'main',
      status: 'creating',
      is_active: false,
    })
    .select('id')
    .single()

  if (error ?? !project) return { error: 'Erro ao criar projeto.' }

  const createdProject = project as { id: string }

  // Log de auditoria
  await supabase.from('audit_logs').insert({
    user_id: user.id,
    action: 'project.create',
    resource_type: 'project',
    resource_id: createdProject.id,
    metadata: { name: parsed.data.name },
  })

  revalidatePath('/dashboard')
  return { projectId: createdProject.id }
}

export interface DeleteProjectResult {
  error?: string
  /** O que não pôde ser removido lá fora e ficou para o usuário limpar. */
  warnings?: string[]
}

/**
 * Exclui o projeto e os recursos externos que ele criou.
 *
 * Regra de ouro: o pedido do usuário é remover o projeto. Se um recurso
 * externo já sumiu, ou o token perdeu acesso, isso vira aviso — não motivo
 * para o projeto ficar preso no painel para sempre, que era o comportamento
 * anterior.
 */
export async function deleteProject(
  projectId: string,
): Promise<DeleteProjectResult> {
  const parsed = z.string().uuid().safeParse(projectId)
  if (!parsed.success) return { error: 'ID de projeto inválido.' }

  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { error: 'Não autorizado.' }

  const { data: project } = await supabase
    .from('projects')
    .select('*')
    .eq('id', parsed.data)
    .eq('user_id', user.id)
    .maybeSingle()

  if (!project) return { error: 'Projeto não encontrado.' }

  const warnings: string[] = []

  // ── Banco Supabase ──────────────────────────────────────────
  if (project.supabase_project_ref && project.supabase_account_id) {
    const { data: account } = await supabase
      .from('supabase_accounts')
      .select('access_token_encrypted')
      .eq('id', project.supabase_account_id)
      .eq('user_id', user.id)
      .maybeSingle()

    if (account) {
      try {
        const response = await fetch(
          `https://api.supabase.com/v1/projects/${project.supabase_project_ref}`,
          {
            method: 'DELETE',
            headers: {
              Authorization: `Bearer ${decryptToken(account.access_token_encrypted as string)}`,
            },
          },
        )

        const detail = response.ok ? '' : await response.text()

        // Já removido não é falha: o efeito desejado já aconteceu.
        const alreadyGone =
          response.status === 404 || /has been removed|not found/i.test(detail)

        if (!response.ok && !alreadyGone) {
          warnings.push(
            response.status === 401 || response.status === 403
              ? 'O banco no Supabase não foi excluído: a conta perdeu acesso. Reconecte-a e apague o projeto pelo painel do Supabase.'
              : `O banco no Supabase não foi excluído (HTTP ${response.status}).`,
          )
        }
      } catch {
        warnings.push('Não foi possível falar com a API do Supabase.')
      }
    }
  }

  // ── Repositório GitHub ──────────────────────────────────────
  if (project.github_repo_full_name && project.github_account_id) {
    const { data: account } = await supabase
      .from('github_accounts')
      .select('access_token_encrypted, login')
      .eq('id', project.github_account_id)
      .eq('user_id', user.id)
      .maybeSingle()

    if (account) {
      try {
        const response = await fetch(
          `https://api.github.com/repos/${project.github_repo_full_name}`,
          {
            method: 'DELETE',
            headers: {
              Authorization: `Bearer ${decryptToken(account.access_token_encrypted as string)}`,
              Accept: 'application/vnd.github+json',
              'X-GitHub-Api-Version': '2022-11-28',
            },
          },
        )

        if (!response.ok && response.status !== 404) {
          warnings.push(
            response.status === 401
              ? `O repositório ${project.github_repo_full_name} não foi excluído: o acesso à conta ${account.login} expirou. Reconecte-a em Contas.`
              : response.status === 403
                ? `Sem permissão para excluir ${project.github_repo_full_name}. Reconecte a conta GitHub concedendo delete_repo.`
                : `O repositório ${project.github_repo_full_name} não foi excluído (HTTP ${response.status}).`,
          )
        }
      } catch {
        warnings.push('Não foi possível falar com a API do GitHub.')
      }
    }
  }

  // ── Preview compartilhado ───────────────────────────────────
  const previewName = project.preview_project_name as string | null
  const preview = sharedPreviewConfig()

  if (previewName && preview) {
    try {
      await deleteSharedPreview(preview, previewName)
    } catch {
      // Órfão na conta compartilhada é problema de quem opera a plataforma,
      // não do usuário — vira registro, não aviso na tela dele.
      console.error(
        `[projects] preview ${previewName} não foi removido da conta compartilhada`,
      )
    }
  }

  // ── Registro no Supremo ─────────────────────────────────────
  const { error: deleteError } = await supabase
    .from('projects')
    .delete()
    .eq('id', parsed.data)
    .eq('user_id', user.id)

  if (deleteError) {
    return { error: 'Falha ao remover o projeto do banco do Supremo.' }
  }

  await supabase.from('audit_logs').insert({
    user_id: user.id,
    action: 'project.delete',
    resource_type: 'project',
    resource_id: parsed.data,
    metadata: { name: project.name, leftovers: warnings.length },
    ip_address: null,
  })

  revalidatePath('/', 'layout')
  return warnings.length > 0 ? { warnings } : {}
}

/**
 * Owners que o usuário pode escolher no form (interseção segura). Nunca expõe
 * installation_id/token/plano — só login + tipo. Vazio se GitHub não conectado.
 */
export async function getOwnerChoices(): Promise<{
  owners: { login: string; type: 'personal' | 'organization' }[]
  /** true = a conta GitHub existe mas falta scope (ex.: read:org) → reautorizar. */
  needsReconnect: boolean
  /** true = nenhuma conta GitHub conectada ainda. */
  notConnected: boolean
}> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { owners: [], needsReconnect: false, notConnected: true }

  const { data: gh } = await supabase
    .from('github_accounts')
    .select('login, access_token_encrypted, scopes')
    .eq('user_id', user.id)
    .maybeSingle()
  if (!gh) return { owners: [], needsReconnect: false, notConnected: true }

  // Nunca esconder a falta de scope: uma conexão sem read:org lista só a conta
  // pessoal, então sinalizamos reconexão em vez de fingir que está completa.
  const needsReconnect = accountNeedsReconnect(
    (gh as { scopes: string[] | null }).scopes,
  )

  const owners = await getSelectableOwners(
    decryptToken((gh as { access_token_encrypted: string }).access_token_encrypted),
    (gh as { login: string }).login,
  )
  return { owners, needsReconnect, notConnected: false }
}

export async function createEmptyProject(
  name: string,
  description?: string,
  kind: ProjectKind = 'solo',
  /** Login do owner escolhido (pessoal ou organização). Ausente → pessoal. */
  owner?: string,
) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { error: 'Não autorizado.' }

  // O tipo é decisão do usuário, mas nunca confiamos no valor cru vindo do
  // cliente: só os três que o scaffold entende.
  const safeKind: ProjectKind = (['public', 'solo', 'team'] as const).includes(
    kind,
  )
    ? kind
    : 'solo'

  // v3 — AUTORIZAÇÃO DE OWNER (anti-forja): nunca confiar no owner cru do cliente.
  // Recalcula no servidor a INTERSEÇÃO (orgs do usuário ∩ installations da App) e
  // exige que o owner escolhido pertença a ela. Sem owner → fluxo pessoal atual.
  let ownerLogin: string | null = null
  let ownerType: 'personal' | 'organization' | null = null
  if (owner) {
    const { data: gh } = await supabase
      .from('github_accounts')
      .select('login, access_token_encrypted')
      .eq('user_id', user.id)
      .maybeSingle()
    if (!gh) {
      return { error: 'Conecte uma conta GitHub antes de escolher onde criar o repo.' }
    }
    const owners = await getSelectableOwners(
      decryptToken((gh as { access_token_encrypted: string }).access_token_encrypted),
      (gh as { login: string }).login,
    )
    if (!isOwnerAllowed(owners, owner)) {
      return { error: 'Owner não autorizado para o seu usuário.' }
    }
    ownerLogin = owner
    ownerType = ownerTypeOf(owners, owner)
  }

  const { data, error } = await supabase
    .from('projects')
    .insert({
      user_id: user.id,
      name,
      description,
      kind: safeKind,
      status: 'creating',
    })
    .select('id')
    .single()

  if (error) {
    if (error.code === '23505') {
      return { error: 'Você já tem um projeto com este nome.' }
    }
    return { error: 'Falha ao criar o projeto.' }
  }

  // Persiste o owner escolhido (best-effort: colunas da migration 015; se ainda
  // não aplicada, o erro é ignorado e o projeto cai no fluxo pessoal padrão).
  if (ownerLogin) {
    await supabase
      .from('projects')
      .update({ github_owner_login: ownerLogin, github_owner_type: ownerType })
      .eq('id', (data as { id: string }).id)
  }

  revalidatePath('/', 'layout')
  return { data }
}
