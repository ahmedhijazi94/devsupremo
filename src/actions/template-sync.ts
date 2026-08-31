'use server'

import { z } from 'zod'
import { requireProjectOwner, toActionError } from '@/lib/auth'
import { freshGithubToken } from '@/lib/github-token'
import {
  commitFiles,
  ensureBranch,
  listOpenPullRequests,
  openOrUpdatePullRequest,
} from '@/lib/mcp/github'
import type { GithubCredentials } from '@/lib/mcp/repository'
import {
  TEMPLATE_VERSION,
  type ProjectKind,
} from '@/lib/templates/project-files'
import {
  planIsEmpty,
  planTemplateSync,
  planToFileChanges,
  type SyncPlan,
} from '@/lib/templates/sync'

/**
 * Atualizar a base do projeto para o template atual, sem recriar o projeto.
 *
 * Traz os consertos que vivem nos rails (cookies do preview, inspector, CI) a
 * projetos que nasceram antes deles. Nunca toca em scaffold — a funcionalidade
 * do app fica intacta. E aplica como PR pelos gates, não como push direto:
 * mesma razão da aba Código ser só leitura — mudança de código passa pelos
 * gates, e isto é mudança de código.
 */

const PROJECT_COLUMNS =
  'id, user_id, name, description, kind, template_version, ' +
  'github_account_id, github_repo_full_name, default_branch'

interface ResolvedProject {
  creds: GithubCredentials
  supabase: Awaited<ReturnType<typeof requireProjectOwner>>['supabase']
  userId: string
  options: { projectName: string; description: string; kind: ProjectKind }
  templateVersion: string | null
}

async function resolveProject(
  projectId: string,
): Promise<
  { ok: true; value: ResolvedProject } | { ok: false; error: string }
> {
  const { user, supabase, project } = await requireProjectOwner(
    projectId,
    PROJECT_COLUMNS,
  )

  const repoFullName = project.github_repo_full_name as string | null
  const accountId = project.github_account_id as string | null
  if (!repoFullName || !accountId) {
    return { ok: false, error: 'Projeto ainda não provisionado no GitHub.' }
  }

  const { data: account } = await supabase
    .from('github_accounts')
    .select('access_token_encrypted, refresh_token_encrypted, token_expires_at')
    .eq('id', accountId)
    .eq('user_id', user.id)
    .maybeSingle()
  if (!account) return { ok: false, error: 'Conta GitHub não encontrada.' }

  const [owner, repo] = repoFullName.split('/')
  if (!owner || !repo) return { ok: false, error: 'Repositório inválido.' }

  // Renova o token de 8h se expirou, senão o PR de atualização falharia com
  // "Bad credentials" — o mesmo que quebrava a aba Código.
  const token = await freshGithubToken(account, (update) =>
    supabase
      .from('github_accounts')
      .update(update)
      .eq('id', accountId)
      .eq('user_id', user.id),
  )

  const defaultBranch = (project.default_branch as string | null) ?? 'main'

  return {
    ok: true,
    value: {
      supabase,
      userId: user.id,
      templateVersion: (project.template_version as string | null) ?? null,
      creds: {
        token,
        repoFullName,
        owner,
        repo,
        branch: defaultBranch,
        defaultBranch,
      },
      options: {
        projectName: project.name as string,
        description: (project.description as string | null) ?? '',
        // Projeto antigo, de antes da coluna, é 'solo' — o que ele já era.
        kind: ((project.kind as string | null) ?? 'solo') as ProjectKind,
      },
    },
  }
}

/** Branch do PR de atualização. Fixo por versão, para reusar o mesmo PR. */
function updateBranch(): string {
  return `supremo/atualizar-base-${TEMPLATE_VERSION}`
}

export interface TemplateSyncStatus {
  projectVersion: string | null
  latestVersion: string
  upToDate: boolean
  /** Rails que vão ser atualizados (caminhos). */
  updates: string[]
  /** Arquivos que faltam e vão ser criados (caminhos). */
  creates: string[]
  /** Scaffold intocado — só a contagem importa para a UI. */
  skipped: number
  /** PR de atualização já aberto esperando merge, se houver. */
  openPr: { number: number; url: string } | null
}

/**
 * O que a atualização faria, sem escrever nada. Lê o repo e compara com o
 * template atual. Se o repo já bate com a base atual, reconcilia a versão
 * gravada — é como a versão volta a "em dia" depois que o PR de atualização é
 * mesclado, sem precisar de um gancho no merge.
 */
export async function getTemplateSyncStatus(
  projectId: string,
): Promise<{ status?: TemplateSyncStatus; error?: string }> {
  if (!z.string().uuid().safeParse(projectId).success) {
    return { error: 'ID inválido.' }
  }

  try {
    const resolved = await resolveProject(projectId)
    if (!resolved.ok) return { error: resolved.error }
    const { creds, options, supabase, userId, templateVersion } = resolved.value

    const plan = await planTemplateSync(creds, options)
    const upToDate = planIsEmpty(plan)

    // Repo já no template atual: grava a versão. Torna o selo "em dia" honesto
    // depois do merge, sem depender de gancho nenhum.
    if (upToDate && templateVersion !== TEMPLATE_VERSION) {
      await supabase
        .from('projects')
        .update({ template_version: TEMPLATE_VERSION })
        .eq('id', projectId)
        .eq('user_id', userId)
    }

    // Se está atrás, pode já haver um PR de atualização aberto esperando merge
    // — sem detectar isso, o cartão mandava "Abrir PR" de novo e confundia.
    let openPr: { number: number; url: string } | null = null
    if (!upToDate) {
      const branch = updateBranch()
      const prs = await listOpenPullRequests(creds)
      const existing = prs.find((pr) => pr.headRef === branch)
      if (existing) openPr = { number: existing.number, url: existing.url }
    }

    return {
      status: {
        projectVersion: templateVersion,
        latestVersion: TEMPLATE_VERSION,
        upToDate,
        updates: plan.updates.map((item) => item.path),
        creates: plan.creates.map((item) => item.path),
        skipped: plan.skipped.length,
        openPr,
      },
    }
  } catch (error) {
    return { error: toActionError(error) }
  }
}

export interface TemplateSyncResult {
  prUrl: string
  prNumber: number
  updated: string[]
  created: string[]
}

/**
 * Abre (ou atualiza) o PR que traz a base do projeto para o template atual.
 * Idempotente: rodar de novo reusa a branch e o PR abertos.
 */
export async function applyTemplateSync(
  projectId: string,
): Promise<{ result?: TemplateSyncResult; upToDate?: boolean; error?: string }> {
  if (!z.string().uuid().safeParse(projectId).success) {
    return { error: 'ID inválido.' }
  }

  try {
    const resolved = await resolveProject(projectId)
    if (!resolved.ok) return { error: resolved.error }
    const { creds, options, supabase, userId } = resolved.value

    const plan = await planTemplateSync(creds, options)
    if (planIsEmpty(plan)) return { upToDate: true }

    const branch = updateBranch()
    await ensureBranch(creds, branch, creds.defaultBranch)

    await commitFiles(
      creds,
      branch,
      `chore: atualizar base para o template ${TEMPLATE_VERSION}`,
      planToFileChanges(plan),
    )

    const pr = await openOrUpdatePullRequest(
      creds,
      branch,
      `Atualizar base do template (${TEMPLATE_VERSION})`,
      buildPrBody(plan),
    )

    await supabase.from('audit_logs').insert({
      user_id: userId,
      action: 'project.template_sync',
      resource_type: 'project',
      resource_id: projectId,
      metadata: {
        template_version: TEMPLATE_VERSION,
        pr: pr.number,
        updated: plan.updates.length,
        created: plan.creates.length,
      },
      ip_address: null,
    })

    return {
      result: {
        prUrl: pr.url,
        prNumber: pr.number,
        updated: plan.updates.map((item) => item.path),
        created: plan.creates.map((item) => item.path),
      },
    }
  } catch (error) {
    return { error: toActionError(error) }
  }
}

function buildPrBody(plan: SyncPlan): string {
  const lines: string[] = [
    `Traz a base deste projeto para o template **${TEMPLATE_VERSION}**.`,
    '',
    'Só toca em arquivos de base (rails) — infraestrutura da qual o Supremo é',
    'dono. Nada de página, migration, teste do app ou `package.json` foi',
    'mexido: a funcionalidade do app fica intacta.',
    '',
    'Os gates rodam neste PR. Revise o diff e faça o merge quando ficar verde.',
    'Se você customizou algum arquivo de base à mão, o diff mostra antes.',
  ]

  if (plan.updates.length > 0) {
    lines.push('', `### Atualizados (${plan.updates.length})`)
    for (const item of plan.updates) lines.push(`- \`${item.path}\``)
  }
  if (plan.creates.length > 0) {
    lines.push('', `### Criados (${plan.creates.length})`)
    for (const item of plan.creates) lines.push(`- \`${item.path}\``)
  }
  if (plan.skipped.length > 0) {
    lines.push(
      '',
      `_${plan.skipped.length} arquivos de app preservados (não sobrescritos)._`,
    )
  }

  return lines.join('\n')
}
