'use server'

import { z } from 'zod'
import { requireProjectOwner, toActionError } from '@/lib/auth'
import { decryptToken } from '@/lib/crypto'
import {
  getChecks,
  getHeadSha,
  getFailedJobLogs,
  listOpenPullRequests,
} from '@/lib/mcp/github'
import type { GithubCredentials } from '@/lib/mcp/repository'

/**
 * Os gates rodando, ao vivo, dentro do Supremo.
 *
 * O CI vive no GitHub Actions; aqui a UI consulta o estado (o cliente chama de
 * poucos em poucos segundos) e, quando algo falha, busca o log com o contexto
 * do erro isolado — não o dump cru. Tudo read-only e só para o dono do projeto.
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
    .select('access_token_encrypted')
    .eq('id', accountId)
    .eq('user_id', user.id)
    .maybeSingle()

  if (!account) return { ok: false, error: 'Conta GitHub não encontrada.' }

  const [owner, repo] = repoFullName.split('/')
  if (!owner || !repo) return { ok: false, error: 'Repositório inválido.' }

  const defaultBranch = (project.default_branch as string | null) ?? 'main'
  return {
    ok: true,
    creds: {
      token: decryptToken(account.access_token_encrypted as string),
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
