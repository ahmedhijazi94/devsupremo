import type { GithubCredentials } from '@/lib/projects/repository'
import { acceptanceMatchesObservation, MAX_ACCEPTANCE_ARCHIVE_BYTES, readAcceptanceArchive, type AcceptanceReport } from '@/lib/checkpoint/acceptance'
import { octokitFor } from './client'

/** Signed storage URL comes from GitHub, is short-lived and receives no token. */
async function readArchive(location: string, signal: AbortSignal): Promise<Buffer> {
  const url = new URL(location)
  if (url.protocol !== 'https:' || url.username || url.password ||
    !['.blob.core.windows.net', '.githubusercontent.com'].some((suffix) => url.hostname.endsWith(suffix))) {
    throw new Error('Destino do artefato não reconhecido.')
  }
  const response = await fetch(url, { redirect: 'error', signal })
  if (!response.ok || !response.body || Number(response.headers.get('content-length') ?? '0') > MAX_ACCEPTANCE_ARCHIVE_BYTES) {
    await response.body?.cancel()
    throw new Error('Artefato indisponível ou acima do limite.')
  }
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let length = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      length += next.value.byteLength
      if (length > MAX_ACCEPTANCE_ARCHIVE_BYTES) {
        await reader.cancel()
        throw new Error('Artefato acima do limite.')
      }
      chunks.push(Buffer.from(next.value))
    }
  } finally { reader.releaseLock() }
  return Buffer.concat(chunks, length)
}

/** One newest trusted CI run. Missing evidence never falls back to an old run. */
export async function getAcceptanceEvidence(creds: GithubCredentials, projectId: string, sha: string): Promise<AcceptanceReport | null> {
  const gh = octokitFor(creds)
  // A single budget covers metadata, download and freshness checks. Optional
  // acceptance capture must not consume the whole webhook/daemon response.
  const signal = AbortSignal.timeout(10_000)
  const repository = `${creds.owner}/${creds.repo}`.toLowerCase()
  const { data: runs } = await gh.actions.listWorkflowRunsForRepo({ owner: creds.owner, repo: creds.repo, head_sha: sha, per_page: 30, request: { signal } })
  const run = runs.workflow_runs.filter((item) => item.head_sha === sha && item.path === '.github/workflows/ci.yml' &&
    item.head_repository?.full_name?.toLowerCase() === repository && ['pull_request', 'push', 'workflow_dispatch'].includes(item.event))
    .sort((left, right) => right.id - left.id)[0]
  if (!run || !run.run_attempt || !run.run_started_at) return null
  const { data: artifacts } = await gh.actions.listWorkflowRunArtifacts({ owner: creds.owner, repo: creds.repo, run_id: run.id, per_page: 100, request: { signal } })
  const matching = artifacts.artifacts.filter((item) => item.name === `supremo-acceptance-${sha}` && !item.expired &&
    item.workflow_run?.id === run.id && item.workflow_run.head_sha === sha && item.size_in_bytes > 0 &&
    item.size_in_bytes <= MAX_ACCEPTANCE_ARCHIVE_BYTES && Date.parse(item.created_at ?? '') >= Date.parse(run.run_started_at!))
  if (matching.length !== 1) return null
  const artifact = matching[0]!
  const download = await gh.actions.downloadArtifact({ owner: creds.owner, repo: creds.repo, artifact_id: artifact.id,
    archive_format: 'zip', request: { redirect: 'manual', signal } })
  const location = download.headers.location
  if (download.status !== 302 || !location) throw new Error('Download do artefato sem redirecionamento autenticado.')
  const evidence = readAcceptanceArchive(await readArchive(location, signal))
  // Recheck the run after download: a rerun can start with this artifact in flight.
  const { data: fresh } = await gh.actions.getWorkflowRun({ owner: creds.owner, repo: creds.repo, run_id: run.id, request: { signal } })
  if (fresh.head_sha !== sha || fresh.run_attempt !== run.run_attempt || fresh.path !== run.path ||
    !acceptanceMatchesObservation(evidence, { projectId, sha, runId: run.id, runAttempt: run.run_attempt,
      startedAt: run.run_started_at, observedAt: new Date().toISOString() })) return null
  return evidence
}
