'use server'

import { z } from 'zod'
import { requireProjectOwner, toActionError } from '@/lib/auth'
import { freshGithubToken } from '@/lib/github-token'
import {
  closePullRequest,
  deleteBranch,
  getChecks,
  getHeadSha,
  getFailedJobLogs,
  getPullRequest,
  listOpenPullRequests,
  mergePullRequest,
} from '@/lib/mcp/github'
import type { GithubCredentials } from '@/lib/mcp/repository'

/**
 * Os gates rodando, ao vivo, dentro do Supremo — e as ações do PR aqui mesmo.
 *
 * O CI vive no GitHub Actions; aqui a UI consulta o estado (o cliente chama de
 * poucos em poucos segundos) e, quando algo falha, busca o log com o contexto
 * do erro isolado. Mesclar e descartar o PR também acontecem por aqui, sem sair
 * para o GitHub — o merge só com todos os gates verdes, como o do agente.
 */

const PROJECT_COLUMNS =
  'id, user_id, github_account_id, github_repo_full_name, ' +
  'active_branch, default_branch'

async function resolveGithub(
  projectId: string,
): Promise<
  { ok: true; creds: GithubCredentials } | { ok: false; error: string }
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

  // Renova o token de 8h se expirou — senão o painel de Testes (que consulta a
  // cada poucos segundos) e as ações de PR quebrariam com "Bad credentials".
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
    creds: {
      token,
      repoFullName,
      owner,
      repo,
      branch: (project.active_branch as string | null) ?? defaultBranch,
      defaultBranch,
    },
  }
}

export interface CheckView {
  name: string
  status: 'queued' | 'in_progress' | 'completed'
  conclusion: string | null
  url: string | null
}

export interface ProjectChecks {
  /** De onde vêm os checks: um PR aberto, ou a branch principal após o merge. */
  source: string
  prNumber: number | null
  ref: string
  state: 'pending' | 'passed' | 'failed'
  summary: string
  checks: CheckView[]
}

export async function getProjectChecks(
  projectId: string,
): Promise<{ data?: ProjectChecks; error?: string }> {
  if (!z.string().uuid().safeParse(projectId).success) {
    return { error: 'ID inválido.' }
  }

  try {
    const resolved = await resolveGithub(projectId)
    if (!resolved.ok) return { error: resolved.error }
    const { creds } = resolved

    // O PR de agente mais recente é o que interessa; sem nenhum, olhamos a
    // branch principal (os checks do último merge).
    const openPrs = await listOpenPullRequests(creds)
    const agentPr = openPrs.find((pr) => pr.isAgentWork) ?? openPrs[0] ?? null

    const ref =
      agentPr?.headSha ?? (await getHeadSha(creds, creds.defaultBranch))
    const checks = await getChecks(creds, ref)

    const summary =
      checks.total === 0
        ? 'Nenhum check ainda — o CI pode não ter começado.'
        : checks.state === 'passed'
          ? `Todos os ${checks.total} gates verdes.`
          : checks.state === 'failed'
            ? `${checks.failed} vermelho(s), ${checks.passed} verde(s).`
            : `${checks.passed}/${checks.total} verdes, ${checks.pending} rodando.`

    return {
      data: {
        source: agentPr
          ? `PR #${agentPr.number} · ${agentPr.headRef}`
          : `branch ${creds.defaultBranch}`,
        prNumber: agentPr?.number ?? null,
        ref,
        state: checks.state,
        summary,
        checks: checks.checks.map((check) => ({
          name: check.name,
          status: check.status,
          conclusion: check.conclusion,
          url: check.url,
        })),
      },
    }
  } catch (error) {
    return { error: toActionError(error) }
  }
}

export async function getCheckLog(
  projectId: string,
  ref: string,
): Promise<{ log?: string; error?: string }> {
  if (!z.string().uuid().safeParse(projectId).success) {
    return { error: 'ID inválido.' }
  }
  if (!/^[0-9a-f]{6,40}$/i.test(ref)) {
    return { error: 'Referência inválida.' }
  }

  try {
    const resolved = await resolveGithub(projectId)
    if (!resolved.ok) return { error: resolved.error }

    const log = await getFailedJobLogs(resolved.creds, ref)
    return { log: log || 'Nenhum log de falha — nada vermelho neste momento.' }
  } catch (error) {
    return { error: toActionError(error) }
  }
}

/**
 * Mescla o PR — mas só com TODOS os gates verdes. A checagem aqui é a mesma do
 * merge_when_green do agente, e a proteção de branch do GitHub recusa por baixo
 * de qualquer jeito. O botão no Supremo não afrouxa nada: falha fechada.
 */
export async function mergeProjectPr(
  projectId: string,
  prNumber: number,
): Promise<{ ok?: true; error?: string }> {
  if (!z.string().uuid().safeParse(projectId).success) {
    return { error: 'ID inválido.' }
  }
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    return { error: 'PR inválido.' }
  }

  try {
    const resolved = await resolveGithub(projectId)
    if (!resolved.ok) return { error: resolved.error }
    const { creds } = resolved

    const pr = await getPullRequest(creds, prNumber)
    const checks = await getChecks(creds, pr.headSha)
    if (checks.state !== 'passed') {
      return {
        error:
          checks.state === 'failed'
            ? 'Tem gate vermelho. Só dá para mesclar com tudo verde.'
            : 'Os gates ainda estão rodando. Espere ficarem verdes.',
      }
    }

    await mergePullRequest(creds, prNumber)
    return { ok: true }
  } catch (error) {
    return { error: toActionError(error) }
  }
}

/** Descarta o PR: fecha e apaga a branch. Não toca no main nem em gate nenhum. */
export async function discardProjectPr(
  projectId: string,
  prNumber: number,
): Promise<{ ok?: true; error?: string }> {
  if (!z.string().uuid().safeParse(projectId).success) {
    return { error: 'ID inválido.' }
  }
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    return { error: 'PR inválido.' }
  }

  try {
    const resolved = await resolveGithub(projectId)
    if (!resolved.ok) return { error: resolved.error }
    const { creds } = resolved

    const pr = await getPullRequest(creds, prNumber)
    if (pr.merged) return { error: 'Este PR já foi mesclado.' }

    await closePullRequest(creds, prNumber)
    // Branch de agente é descartável; apagá-la limpa a lista de PRs.
    await deleteBranch(creds, pr.headRef)
    return { ok: true }
  } catch (error) {
    return { error: toActionError(error) }
  }
}
