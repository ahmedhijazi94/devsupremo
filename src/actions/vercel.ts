'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireUser, requireProjectOwner, toActionError } from '@/lib/auth'
import { decryptToken, encryptToken } from '@/lib/crypto'
import { createOAuthState } from '@/lib/oauth-state'
import {
  identify,
  installationUrl,
  latestDeployment,
  oauthConfig,
  type Deployment,
} from '@/lib/vercel'
import { redirect } from 'next/navigation'

/**
 * Conexão da conta Vercel e leitura do estado do preview.
 *
 * O preview de cada projeto é um deploy real na conta do próprio usuário —
 * não numa conta central do Supremo. É o mesmo princípio do GitHub e do
 * Supabase: o que é publicado pertence a quem publicou.
 */

/** Se o OAuth está configurado, a UI oferece o clique em vez do token. */
export async function isVercelOAuthAvailable(): Promise<boolean> {
  return oauthConfig() !== null
}

/**
 * Inicia a instalação da Integration da Vercel.
 *
 * Mesmo desenho do GitHub e do Supabase: state de uso único guardado no
 * banco, validado e consumido no callback.
 */
export async function startVercelOAuth(projectId?: string): Promise<void> {
  const config = oauthConfig()
  if (!config) {
    throw new Error(
      'OAuth da Vercel não configurado neste ambiente. Use o token pessoal.'
    )
  }

  const { user, supabase } = await requireUser()
  const state = await createOAuthState(supabase, user.id, 'vercel', projectId)

  redirect(installationUrl(config, state))
}

const connectSchema = z.object({
  token: z
    .string()
    .min(20, 'O token parece curto demais.')
    .max(200, 'O token parece longo demais.'),
})

export async function connectVercelAccount(
  input: z.infer<typeof connectSchema>
): Promise<{ error?: string; accountName?: string }> {
  const parsed = connectSchema.safeParse(input)
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Token inválido.' }
  }

  try {
    const { user, supabase } = await requireUser()

    // Valida contra a API antes de guardar: token errado deve falhar aqui,
    // não semanas depois na hora de publicar.
    const identity = await identify(parsed.data.token)

    const { error } = await supabase.from('vercel_accounts').upsert(
      {
        user_id: user.id,
        account_name: identity.accountName,
        team_id: identity.teamId,
        access_token_encrypted: encryptToken(parsed.data.token),
      },
      { onConflict: 'user_id,team_id' }
    )

    if (error) return { error: 'Erro ao salvar a conta Vercel.' }

    await supabase.from('audit_logs').insert({
      user_id: user.id,
      action: 'vercel_account.connect',
      resource_type: 'vercel_account',
      resource_id: null,
      metadata: { account: identity.accountName },
      ip_address: null,
    })

    revalidatePath('/accounts')
    return { accountName: identity.accountName }
  } catch (error) {
    return { error: toActionError(error) }
  }
}

export async function disconnectVercelAccount(
  accountId: string
): Promise<{ error?: string }> {
  const parsed = z.string().uuid().safeParse(accountId)
  if (!parsed.success) return { error: 'ID inválido.' }

  try {
    const { user, supabase } = await requireUser()

    const { error } = await supabase
      .from('vercel_accounts')
      .delete()
      .eq('id', parsed.data)
      .eq('user_id', user.id)

    if (error) return { error: 'Erro ao desconectar a conta.' }

    revalidatePath('/accounts')
    return {}
  } catch (error) {
    return { error: toActionError(error) }
  }
}

// ─────────────────────────────────────────────────────────────
// Estado do preview
// ─────────────────────────────────────────────────────────────

export interface PreviewState {
  /** Sem conta Vercel conectada, ou projeto ainda não vinculado. */
  status: 'not_connected' | 'no_deployment' | 'building' | 'ready' | 'error'
  url?: string
  branch?: string
  inspectorUrl?: string
  message?: string
}

export async function getPreviewState(
  projectId: string
): Promise<PreviewState> {
  try {
    const { user, supabase, project } = await requireProjectOwner(
      projectId,
      'id, user_id, vercel_account_id, vercel_project_id, active_branch, default_branch'
    )

    const accountId = project.vercel_account_id as string | null
    const vercelProjectId = project.vercel_project_id as string | null

    if (!accountId || !vercelProjectId) {
      return {
        status: 'not_connected',
        message:
          'Conecte uma conta Vercel em Contas para este projeto ganhar preview.',
      }
    }

    const { data: account } = await supabase
      .from('vercel_accounts')
      .select('access_token_encrypted, team_id')
      .eq('id', accountId)
      .eq('user_id', user.id)
      .maybeSingle()

    if (!account) {
      return { status: 'not_connected', message: 'Conta Vercel não encontrada.' }
    }

    const token = decryptToken(account.access_token_encrypted as string)
    const teamId = (account.team_id as string | null) ?? null

    const branch =
      (project.active_branch as string | null) ??
      (project.default_branch as string | null) ??
      'main'

    // Preferimos o deploy da branch ativa; sem ele, o mais recente serve
    // para o usuário ver alguma coisa em vez de uma tela vazia.
    const deployment =
      (await latestDeployment(token, teamId, vercelProjectId, branch)) ??
      (await latestDeployment(token, teamId, vercelProjectId))

    if (!deployment) {
      return {
        status: 'no_deployment',
        message: 'Nenhum deploy ainda. O primeiro sai no próximo commit.',
      }
    }

    return describeDeployment(deployment)
  } catch (error) {
    return { status: 'error', message: toActionError(error) }
  }
}

function describeDeployment(deployment: Deployment): PreviewState {
  // Com exactOptionalPropertyTypes, chave presente com undefined é diferente
  // de chave ausente — então elas só entram quando há valor.
  const base = {
    url: deployment.url,
    ...(deployment.branch ? { branch: deployment.branch } : {}),
    ...(deployment.inspectorUrl
      ? { inspectorUrl: deployment.inspectorUrl }
      : {}),
  }

  if (deployment.state === 'READY') {
    return { status: 'ready', ...base }
  }

  if (deployment.state === 'ERROR' || deployment.state === 'CANCELED') {
    return {
      status: 'error',
      ...base,
      message:
        'O build falhou. Abra os logs na Vercel para ver o que quebrou — ' +
        'ou peça ao agente com get_failed_logs.',
    }
  }

  return {
    status: 'building',
    ...base,
    message: 'Publicando. Isso leva algumas dezenas de segundos.',
  }
}
