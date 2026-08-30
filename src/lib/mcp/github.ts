import { Octokit } from '@octokit/rest'
import type { GithubCredentials } from './repository'

/**
 * Operações de GitHub usadas pelas ferramentas de MCP.
 *
 * O modelo é branch → PR → checks → merge. Nada aqui escreve na branch
 * default diretamente: é o gate que torna o pipeline não contornável.
 */

export interface FileChange {
  path: string
  /** `null` remove o arquivo. */
  content: string | null
}

export interface CheckSummary {
  name: string
  status: 'queued' | 'in_progress' | 'completed'
  conclusion: string | null
  url: string | null
  runId: number | null
}

export interface ChecksResult {
  state: 'pending' | 'passed' | 'failed'
  total: number
  passed: number
  failed: number
  pending: number
  checks: CheckSummary[]
  headSha: string
}

export function octokitFor(creds: GithubCredentials): Octokit {
  return new Octokit({ auth: creds.token })
}

// ─────────────────────────────────────────────────────────────
// Leitura
// ─────────────────────────────────────────────────────────────

export async function readFile(
  creds: GithubCredentials,
  path: string,
  ref?: string,
): Promise<string> {
  const gh = octokitFor(creds)

  const response = await gh.repos.getContent({
    owner: creds.owner,
    repo: creds.repo,
    path,
    ref: ref ?? creds.branch,
  })

  const data = response.data
  if (Array.isArray(data) || data.type !== 'file' || !('content' in data)) {
    throw new Error(`"${path}" não é um arquivo.`)
  }

  return Buffer.from(data.content, 'base64').toString('utf8')
}

export async function listTree(
  creds: GithubCredentials,
  ref?: string,
): Promise<Array<{ path: string; size: number }>> {
  const gh = octokitFor(creds)

  const { data } = await gh.git.getTree({
    owner: creds.owner,
    repo: creds.repo,
    tree_sha: ref ?? creds.branch,
    recursive: 'true',
  })

  return data.tree
    .filter((entry) => entry.type === 'blob' && entry.path)
    .map((entry) => ({ path: entry.path as string, size: entry.size ?? 0 }))
}

export async function getHeadSha(
  creds: GithubCredentials,
  branch: string,
): Promise<string> {
  const gh = octokitFor(creds)
  const { data } = await gh.git.getRef({
    owner: creds.owner,
    repo: creds.repo,
    ref: `heads/${branch}`,
  })
  return data.object.sha
}

// ─────────────────────────────────────────────────────────────
// Escrita — sempre em branch
// ─────────────────────────────────────────────────────────────

export async function ensureBranch(
  creds: GithubCredentials,
  branch: string,
  fromBranch?: string,
): Promise<{ created: boolean; sha: string }> {
  const gh = octokitFor(creds)

  try {
    const existing = await gh.git.getRef({
      owner: creds.owner,
      repo: creds.repo,
      ref: `heads/${branch}`,
    })
    return { created: false, sha: existing.data.object.sha }
  } catch {
    // Branch não existe — cria a partir da base.
  }

  const baseSha = await getHeadSha(creds, fromBranch ?? creds.defaultBranch)

  await gh.git.createRef({
    owner: creds.owner,
    repo: creds.repo,
    ref: `refs/heads/${branch}`,
    sha: baseSha,
  })

  return { created: true, sha: baseSha }
}

export async function commitFiles(
  creds: GithubCredentials,
  branch: string,
  message: string,
  files: FileChange[],
): Promise<{ sha: string; url: string }> {
  if (files.length === 0) {
    throw new Error('Nenhum arquivo para commitar.')
  }

  const gh = octokitFor(creds)
  const headSha = await getHeadSha(creds, branch)

  const { data: headCommit } = await gh.git.getCommit({
    owner: creds.owner,
    repo: creds.repo,
    commit_sha: headSha,
  })

  const tree = files.map((file) =>
    file.content === null
      ? {
          path: file.path,
          mode: '100644' as const,
          type: 'blob' as const,
          sha: null,
        }
      : {
          path: file.path,
          mode: '100644' as const,
          type: 'blob' as const,
          content: file.content,
        },
  )

  const { data: newTree } = await gh.git.createTree({
    owner: creds.owner,
    repo: creds.repo,
    base_tree: headCommit.tree.sha,
    tree,
  })

  const { data: commit } = await gh.git.createCommit({
    owner: creds.owner,
    repo: creds.repo,
    message,
    tree: newTree.sha,
    parents: [headSha],
  })

  await gh.git.updateRef({
    owner: creds.owner,
    repo: creds.repo,
    ref: `heads/${branch}`,
    sha: commit.sha,
  })

  return { sha: commit.sha, url: commit.html_url }
}

// ─────────────────────────────────────────────────────────────
// Pull requests
// ─────────────────────────────────────────────────────────────

export interface PullRequestInfo {
  number: number
  url: string
  headSha: string
  state: string
  merged: boolean
  mergeable: boolean | null
}

export async function openOrUpdatePullRequest(
  creds: GithubCredentials,
  head: string,
  title: string,
  body: string,
  base?: string,
): Promise<PullRequestInfo> {
  const gh = octokitFor(creds)
  const baseBranch = base ?? creds.defaultBranch

  const { data: existing } = await gh.pulls.list({
    owner: creds.owner,
    repo: creds.repo,
    head: `${creds.owner}:${head}`,
    state: 'open',
  })

  const openPr = existing[0]
  if (openPr) {
    return {
      number: openPr.number,
      url: openPr.html_url,
      headSha: openPr.head.sha,
      state: openPr.state,
      merged: false,
      mergeable: null,
    }
  }

  const { data: created } = await gh.pulls.create({
    owner: creds.owner,
    repo: creds.repo,
    head,
    base: baseBranch,
    title,
    body,
  })

  return {
    number: created.number,
    url: created.html_url,
    headSha: created.head.sha,
    state: created.state,
    merged: false,
    mergeable: created.mergeable,
  }
}

export async function getPullRequest(
  creds: GithubCredentials,
  prNumber: number,
): Promise<PullRequestInfo> {
  const gh = octokitFor(creds)
  const { data } = await gh.pulls.get({
    owner: creds.owner,
    repo: creds.repo,
    pull_number: prNumber,
  })

  return {
    number: data.number,
    url: data.html_url,
    headSha: data.head.sha,
    state: data.state,
    merged: data.merged,
    mergeable: data.mergeable,
  }
}

export interface OpenPullRequest {
  number: number
  title: string
  headRef: string
  headSha: string
  url: string
  updatedAt: string
  /** É uma migration esperando o teste de RLS virar verde? Ajuda a priorizar. */
  isMigration: boolean
}

/**
 * PRs abertos do projeto, do mais recente ao mais antigo.
 *
 * É a peça que faltava para "continuar de onde parou": sem listar o que está
 * aberto, um agente que conecta de outra máquina não tem como saber que existe
 * trabalho pendente. Ele veria só o branch ativo — não o PR #7 com um gate
 * vermelho esperando conserto.
 */
export async function listOpenPullRequests(
  creds: GithubCredentials,
): Promise<OpenPullRequest[]> {
  const gh = octokitFor(creds)
  const { data } = await gh.pulls.list({
    owner: creds.owner,
    repo: creds.repo,
    state: 'open',
    sort: 'updated',
    direction: 'desc',
    // Trabalho a retomar é sempre um punhado; os 10 mais recentes cobrem todo
    // caso real e limitam o fan-out de getChecks na chamada de contexto.
    per_page: 10,
  })

  return data.map((pr) => ({
    number: pr.number,
    title: pr.title,
    headRef: pr.head.ref,
    headSha: pr.head.sha,
    url: pr.html_url,
    updatedAt: pr.updated_at,
    isMigration: pr.head.ref.startsWith('migration/'),
  }))
}

export async function mergePullRequest(
  creds: GithubCredentials,
  prNumber: number,
  commitTitle?: string,
): Promise<{ sha: string }> {
  const gh = octokitFor(creds)
  const { data } = await gh.pulls.merge({
    owner: creds.owner,
    repo: creds.repo,
    pull_number: prNumber,
    merge_method: 'squash',
    ...(commitTitle ? { commit_title: commitTitle } : {}),
  })

  if (!data.merged) {
    throw new Error(data.message || 'GitHub recusou o merge.')
  }

  return { sha: data.sha }
}

// ─────────────────────────────────────────────────────────────
// Checks — o gate
// ─────────────────────────────────────────────────────────────

export async function getChecks(
  creds: GithubCredentials,
  ref: string,
): Promise<ChecksResult> {
  const gh = octokitFor(creds)

  const { data } = await gh.checks.listForRef({
    owner: creds.owner,
    repo: creds.repo,
    ref,
    per_page: 100,
  })

  const checks: CheckSummary[] = data.check_runs.map((run) => ({
    name: run.name,
    status: run.status as CheckSummary['status'],
    conclusion: run.conclusion,
    url: run.html_url,
    runId: extractRunId(run.details_url ?? run.html_url ?? null),
  }))

  const passed = checks.filter(
    (c) => c.conclusion === 'success' || c.conclusion === 'skipped',
  ).length
  const failed = checks.filter(
    (c) =>
      c.conclusion === 'failure' ||
      c.conclusion === 'timed_out' ||
      c.conclusion === 'cancelled',
  ).length
  const pending = checks.filter((c) => c.status !== 'completed').length

  let state: ChecksResult['state'] = 'pending'
  if (failed > 0) state = 'failed'
  else if (pending === 0 && checks.length > 0) state = 'passed'

  return {
    state,
    total: checks.length,
    passed,
    failed,
    pending,
    checks,
    headSha: ref,
  }
}

function extractRunId(url: string | null): number | null {
  if (!url) return null
  const match = /\/runs\/(\d+)/.exec(url)
  return match?.[1] ? Number(match[1]) : null
}

/**
 * Baixa a saída dos jobs que falharam. É isso que volta para o agente
 * corrigir o próprio erro em vez de adivinhar.
 */
export async function getFailedJobLogs(
  creds: GithubCredentials,
  ref: string,
  maxChars = 12_000,
): Promise<string> {
  const gh = octokitFor(creds)

  const { data: runs } = await gh.actions.listWorkflowRunsForRepo({
    owner: creds.owner,
    repo: creds.repo,
    head_sha: ref,
    per_page: 20,
  })

  // Procuramos JOBS que falharam, não runs com conclusão de falha.
  //
  // Um run só recebe conclusion "failure" quando todos os seus jobs
  // terminam. O agente chama esta ferramenta logo depois de wait_for_checks
  // apontar vermelho — momento em que o run ainda está in_progress e sua
  // conclusion é null. Filtrar por conclusion do run devolvia "nenhum job
  // falhou" exatamente quando havia falha para reportar.
  const sections: string[] = []
  let inspected = 0

  for (const run of runs.workflow_runs) {
    if (inspected >= 3) break

    const { data: jobs } = await gh.actions.listJobsForWorkflowRun({
      owner: creds.owner,
      repo: creds.repo,
      run_id: run.id,
      per_page: 50,
    })

    const failedJobs = jobs.jobs.filter(
      (job) =>
        job.conclusion === 'failure' ||
        job.conclusion === 'timed_out' ||
        job.conclusion === 'cancelled',
    )

    if (failedJobs.length === 0) continue
    inspected++

    for (const job of failedJobs) {
      const failedSteps = (job.steps ?? [])
        .filter((step) => step.conclusion === 'failure')
        .map((step) => step.name)
        .join(', ')

      sections.push(
        `### ${run.name} › ${job.name} (${job.conclusion})\n` +
          (failedSteps ? `Passo que falhou: ${failedSteps}\n` : '') +
          `${job.html_url}\n\n` +
          (await downloadJobLog(gh, creds, job.id)),
      )
    }
  }

  if (sections.length === 0) {
    const stillRunning = runs.workflow_runs.some(
      (run) => run.status !== 'completed',
    )
    return stillRunning
      ? 'Nenhum job falhou ainda — o CI segue rodando. Chame wait_for_checks.'
      : 'Nenhum job falhou para este commit.'
  }

  const combined = sections.join('\n\n---\n\n')
  return combined.length > maxChars
    ? `${combined.slice(0, maxChars)}\n\n[…log truncado…]`
    : combined
}

async function downloadJobLog(
  gh: Octokit,
  creds: GithubCredentials,
  jobId: number,
): Promise<string> {
  try {
    const response = await gh.actions.downloadJobLogsForWorkflowRun({
      owner: creds.owner,
      repo: creds.repo,
      job_id: jobId,
    })

    const raw =
      typeof response.data === 'string'
        ? response.data
        : Buffer.from(response.data as ArrayBuffer).toString('utf8')

    return extractFailureContext(raw)
  } catch {
    return '[não foi possível baixar o log deste job]'
  }
}

/**
 * Recorta a parte do log que explica a falha.
 *
 * Pegar as últimas linhas parece razoável mas falha justamente nos jobs
 * mais barulhentos: CodeQL e Playwright escrevem centenas de linhas depois
 * do erro, e o agente recebia o rodapé em vez da causa. Aqui procuramos os
 * marcadores de erro do Actions e devolvemos o contexto ao redor.
 */
function extractFailureContext(raw: string, window = 60): string {
  const lines = raw.split('\n')

  const markers = [/##\[error\]/, /^\s*Error:/, /\bnpm ERR!/, /FAIL\b/]
  const firstError = lines.findIndex((line) =>
    markers.some((marker) => marker.test(line)),
  )

  if (firstError === -1) {
    return lines.slice(-window).join('\n')
  }

  const start = Math.max(0, firstError - 10)
  const end = Math.min(lines.length, firstError + window)
  const excerpt = lines.slice(start, end).join('\n')

  return start > 0 ? `[…${start} linhas antes…]\n${excerpt}` : excerpt
}

// ─────────────────────────────────────────────────────────────
// Proteção de branch — torna o gate obrigatório
// ─────────────────────────────────────────────────────────────

export async function enableBranchProtection(
  creds: GithubCredentials,
  branch: string,
  requiredChecks: string[],
): Promise<void> {
  const gh = octokitFor(creds)

  await gh.repos.updateBranchProtection({
    owner: creds.owner,
    repo: creds.repo,
    branch,
    required_status_checks: {
      strict: true,
      contexts: requiredChecks,
    },
    enforce_admins: false,
    required_pull_request_reviews: null,
    restrictions: null,
    allow_force_pushes: false,
    allow_deletions: false,
  })
}
