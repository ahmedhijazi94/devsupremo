import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { acceptanceArchive, acceptanceFixture } from '@/test/fixtures/acceptance'
import type { GithubCredentials } from '@/lib/projects/repository'
import { MAX_ACCEPTANCE_ARCHIVE_BYTES } from '@/lib/checkpoint/acceptance'

const api = vi.hoisted(() => ({ runs: vi.fn(), artifacts: vi.fn(), download: vi.fn(), fresh: vi.fn() }))
vi.mock('./client', () => ({ octokitFor: () => ({ actions: {
  listWorkflowRunsForRepo: api.runs, listWorkflowRunArtifacts: api.artifacts, downloadArtifact: api.download, getWorkflowRun: api.fresh,
} }) }))
import { getAcceptanceEvidence } from './acceptance'

const sha = acceptanceFixture.sha
const credentials: GithubCredentials = { owner: 'team', repo: 'app', repoFullName: 'team/app', token: 'private-github-token', branch: 'main', defaultBranch: 'main' }
const run = { id: 10, run_attempt: 1, head_sha: sha, path: '.github/workflows/ci.yml',
  head_repository: { full_name: 'team/app' }, event: 'pull_request', run_started_at: '2026-09-06T01:00:00.000Z' }
const artifact = { id: 20, name: `supremo-acceptance-${sha}`, expired: false, size_in_bytes: 1000,
  workflow_run: { id: 10, head_sha: sha }, created_at: '2026-09-06T01:05:01.000Z' }
const retrieve = () => getAcceptanceEvidence(credentials, acceptanceFixture.projectId, sha)

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-06T01:06:00.000Z'))
  vi.resetAllMocks()
  api.runs.mockResolvedValue({ data: { workflow_runs: [run] } })
  api.artifacts.mockResolvedValue({ data: { artifacts: [artifact] } })
  api.download.mockResolvedValue({ status: 302, headers: { location: 'https://githubstorage.blob.core.windows.net/artifact?sig=private-signed-url' } })
  api.fresh.mockResolvedValue({ data: run })
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(acceptanceArchive()))))
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('GitHub acceptance artifact provenance', () => {
  it('reads only the named artifact of the matching trusted workflow and never forwards credentials to storage', async () => {
    expect(await retrieve()).toEqual(acceptanceFixture)
    expect(api.runs).toHaveBeenCalledWith(expect.objectContaining({ head_sha: sha }))
    expect(api.artifacts).toHaveBeenCalledWith(expect.objectContaining({ run_id: 10 }))
    expect(api.download).toHaveBeenCalledWith(expect.objectContaining({ artifact_id: 20, request: expect.objectContaining({ redirect: 'manual' }) }))
    expect(fetch).toHaveBeenCalledWith(expect.any(URL), { redirect: 'error', signal: expect.any(AbortSignal) })
    expect(JSON.stringify(vi.mocked(fetch).mock.calls)).not.toContain(credentials.token)
  })
  it.each(['different_sha', 'other_workflow', 'fork', 'untrusted_event', 'missing_attempt'])('ignores %s runs before inspecting artifacts', async (kind) => {
    const patch = kind === 'different_sha' ? { head_sha: 'a'.repeat(40) } : kind === 'other_workflow' ? { path: '.github/workflows/other.yml' }
      : kind === 'fork' ? { head_repository: { full_name: 'attacker/app' } } : kind === 'untrusted_event' ? { event: 'workflow_run' } : { run_attempt: null }
    api.runs.mockResolvedValue({ data: { workflow_runs: [{ ...run, ...patch }] } })
    expect(await retrieve()).toBeNull()
    expect(api.artifacts).not.toHaveBeenCalled()
  })
  it('does not fall back to a previous green run when the latest run has no artifact', async () => {
    api.runs.mockResolvedValue({ data: { workflow_runs: [run, { ...run, id: 11 }] } })
    api.artifacts.mockResolvedValue({ data: { artifacts: [] } })
    expect(await retrieve()).toBeNull()
    expect(api.artifacts).toHaveBeenCalledTimes(1)
    expect(api.artifacts).toHaveBeenCalledWith(expect.objectContaining({ run_id: 11 }))
  })
  it.each(['missing', 'expired', 'wrong_name', 'wrong_sha', 'wrong_run', 'old_attempt', 'large', 'duplicate'])('ignores %s artifacts without downloading', async (kind) => {
    const patch = kind === 'expired' ? { expired: true } : kind === 'wrong_name' ? { name: 'other-proof' }
      : kind === 'wrong_sha' ? { workflow_run: { id: 10, head_sha: 'a'.repeat(40) } } : kind === 'wrong_run' ? { workflow_run: { id: 9, head_sha: sha } }
        : kind === 'old_attempt' ? { created_at: '2026-09-05T01:05:00.000Z' } : kind === 'large' ? { size_in_bytes: MAX_ACCEPTANCE_ARCHIVE_BYTES + 1 } : {}
    api.artifacts.mockResolvedValue({ data: { artifacts: kind === 'missing' ? [] : kind === 'duplicate' ? [artifact, artifact] : [{ ...artifact, ...patch }] } })
    expect(await retrieve()).toBeNull()
    expect(api.download).not.toHaveBeenCalled()
  })
  it('ignores an old attempt report even when artifact metadata has been copied into a new attempt', async () => {
    api.runs.mockResolvedValue({ data: { workflow_runs: [{ ...run, run_attempt: 2 }] } })
    api.fresh.mockResolvedValue({ data: { ...run, run_attempt: 2 } })
    expect(await retrieve()).toBeNull()
  })
  it('rechecks attempt freshness after the download', async () => {
    api.fresh.mockResolvedValue({ data: { ...run, run_attempt: 2 } })
    expect(await retrieve()).toBeNull()
  })
  it.each(['http://githubstorage.blob.core.windows.net/file', 'https://user:pass@githubstorage.blob.core.windows.net/file', 'https://attacker.example/file'])('refuses unexpected artifact destination %s', async (location) => {
    api.download.mockResolvedValue({ status: 302, headers: { location } })
    await expect(retrieve()).rejects.toThrow(/Destino/)
    expect(fetch).not.toHaveBeenCalled()
  })
  it.each(['corrupt', 'size_header', 'size_stream', 'missing_location'])('never accepts %s downloads', async (kind) => {
    if (kind === 'missing_location') api.download.mockResolvedValue({ status: 302, headers: {} })
    else vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(kind === 'size_stream' ? MAX_ACCEPTANCE_ARCHIVE_BYTES + 1 : 3), {
      ...(kind === 'size_header' ? { headers: { 'Content-Length': String(MAX_ACCEPTANCE_ARCHIVE_BYTES + 1) } } : {}),
    })))
    await expect(retrieve()).rejects.toThrow()
  })
})
