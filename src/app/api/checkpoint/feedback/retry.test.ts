import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CI_JOB_NAMES } from '@/lib/templates/project-files'

const mocks = vi.hoisted(() => ({
  auth: vi.fn(), project: vi.fn(), latest: vi.fn(), cached: vi.fn(), save: vi.fn(), envelope: vi.fn(),
  appToken: vi.fn(), credentials: vi.fn(), checks: vi.fn(), pr: vi.fn(), trustedChecks: vi.fn(),
  policy: vi.fn(), scanning: vi.fn(), merge: vi.fn(), protection: vi.fn(), meta: vi.fn(),
  writeMeta: vi.fn(), reconcileRows: vi.fn(), gateway: vi.fn(),
}))
vi.mock('@/lib/supabase/admin', () => ({ createServiceClient: () => ({}) }))
vi.mock('@/lib/checkpoint/devices', () => ({ authenticateDeviceSecret: mocks.auth }))
vi.mock('@/lib/checkpoint/store', () => ({
  supabaseCheckpointDeviceStore: () => ({}), getLatestKnownCheckpoint: mocks.latest, reconcileCheckpointsForPr: mocks.reconcileRows,
}))
vi.mock('@/lib/checkpoint/feedback-store', () => ({ readCheckpointFeedback: mocks.cached, saveCheckpointFeedback: mocks.save, readFeedbackEnvelope: mocks.envelope }))
vi.mock('@/lib/projects/repository', () => ({ getProject: mocks.project, getGithubCredentials: mocks.credentials,
  readIntegrationMeta: mocks.meta, writeIntegrationMeta: mocks.writeMeta, NotFoundError: class extends Error {} }))
vi.mock('@/lib/github/client', () => ({ getChecks: mocks.checks, getFailedJobLogs: vi.fn(async () => '') }))
vi.mock('@/lib/github/app', () => ({ appTokenForRepo: mocks.appToken, installationCreds: (_token: string, repo: string) => ({ repoFullName: repo }) }))
vi.mock('@/lib/github/gateway', () => ({ githubMergeGateway: mocks.gateway }))
vi.mock('@/lib/github/acceptance', () => ({ getAcceptanceEvidence: vi.fn(async () => null) }))
import { POST } from './route'

const projectId = '11111111-1111-4111-8111-111111111111'
const checkpointId = '22222222-2222-4222-8222-222222222222'
const sha = 'b'.repeat(40)
const initial = { id: checkpointId, commitSha: 'a'.repeat(40), publishedSha: sha, pushStatus: 'published', prNumber: 1, integrationBranch: 'supremo/cp-one' }
let current = { ...initial }
let merged = false
const checks = () => CI_JOB_NAMES.map(name => ({ name, status: 'completed', conclusion: 'success' }))
const request = () => new Request('http://localhost/api/checkpoint/feedback', { method: 'POST', body: JSON.stringify({ projectId, deviceSecret: 'sup_dev_ckpt_test' }) })

beforeEach(() => {
  vi.resetAllMocks()
  current = { ...initial }; merged = false
  mocks.auth.mockResolvedValue({ ok: true, device: { ownerUserId: 'owner' } })
  mocks.project.mockResolvedValue({ id: projectId, user_id: 'owner', github_repo_full_name: 'owner/app', default_branch: 'main' })
  mocks.latest.mockImplementation(async () => ({ ...current }))
  mocks.cached.mockResolvedValue(null)
  mocks.credentials.mockResolvedValue({ repoFullName: 'owner/app' })
  mocks.appToken.mockResolvedValue('private-app-token')
  mocks.checks.mockResolvedValue({ headSha: sha, checks: checks() })
  mocks.trustedChecks.mockResolvedValue({ headSha: sha, checks: checks() })
  mocks.pr.mockImplementation(async () => ({ headSha: sha, headRef: initial.integrationBranch, state: merged ? 'closed' : 'open', merged, nodeId: 'node' }))
  mocks.policy.mockResolvedValue({ approved: true, headSha: sha, reasons: [] })
  mocks.scanning.mockResolvedValue({ status: 'passed', headSha: sha, reasons: [] })
  mocks.protection.mockResolvedValue(true)
  mocks.meta.mockResolvedValue({ mergeMode: 'supremo_managed', integrationState: 'ci_running' })
  mocks.merge.mockImplementation(async () => { if (merged) throw new Error('PR already merged'); merged = true; return { sha } })
  mocks.reconcileRows.mockImplementation(async (_client, _target, status) => { if (status.pushStatus) current.pushStatus = status.pushStatus })
  mocks.envelope.mockResolvedValue({ current: null, previousFailure: null })
  mocks.gateway.mockReturnValue({ getPullRequest: mocks.pr, getChecks: mocks.trustedChecks, getCodeScanning: mocks.scanning,
    verifyPolicy: mocks.policy, hasRequiredChecks: mocks.protection, merge: mocks.merge, deleteBranch: vi.fn() })
})

describe('daemon feedback retry uses the full integration controller', () => {
  it('recovers a lost event after green CI and persists confirmed integration, then does not merge again', async () => {
    expect((await POST(request())).status).toBe(200)
    expect(mocks.appToken).toHaveBeenCalledWith('owner/app')
    expect(mocks.meta).toHaveBeenCalledWith(projectId, { strict: true })
    expect(mocks.trustedChecks).toHaveBeenCalledWith(sha)
    expect(mocks.policy).toHaveBeenCalledWith(sha)
    expect(mocks.scanning).toHaveBeenCalledTimes(2)
    expect(mocks.merge).toHaveBeenCalledWith(1, sha)
    expect(mocks.reconcileRows).toHaveBeenCalledWith({}, { projectId, prNumber: 1, publishedSha: sha }, { pushStatus: 'integrated', integrationStatus: 'merged' })
    expect(mocks.writeMeta).toHaveBeenCalledWith(projectId, { integration_state: 'merged' }, { expectedState: 'ci_running' })
    expect(mocks.save.mock.calls.at(-1)?.[1]).toMatchObject({ state: 'integrated', checkpointId, publishedSha: sha })
    await POST(request())
    expect(mocks.merge).toHaveBeenCalledTimes(1)
  })
  it.each(['forged-checks', 'policy', 'codeql', 'native-protection'])('generic green checks never bypass %s', async (block) => {
    if (block === 'forged-checks') mocks.trustedChecks.mockResolvedValue({ headSha: sha, checks: [] })
    if (block === 'policy') mocks.policy.mockResolvedValue({ approved: false, headSha: sha, reasons: ['Untrusted policy'] })
    if (block === 'codeql') mocks.scanning.mockResolvedValue({ status: 'failed', headSha: sha, reasons: ['CodeQL failed'] })
    if (block === 'native-protection') { mocks.meta.mockResolvedValue({ mergeMode: 'native' }); mocks.protection.mockResolvedValue(false) }
    expect((await POST(request())).status).toBe(200)
    expect(mocks.merge).not.toHaveBeenCalled()
    expect(mocks.reconcileRows.mock.calls[0]?.[2]).toMatchObject({ pushStatus: null })
    expect(mocks.save.mock.calls.some(call => call[1].state === 'integrated')).toBe(false)
  })
  it('retries a transient independent gate failure on the next expired heartbeat without another GitHub event', async () => {
    mocks.scanning.mockResolvedValueOnce({ status: 'unavailable', headSha: sha, reasons: ['Provider unavailable'] })
    await POST(request())
    expect(mocks.merge).not.toHaveBeenCalled()
    expect(mocks.reconcileRows.mock.calls[0]?.[2]).toMatchObject({ pushStatus: null, integrationStatus: 'security_blocked' })
    mocks.cached.mockResolvedValue({ observedAt: new Date(Date.now() - 46_000).toISOString() })
    await POST(request())
    expect(mocks.merge).toHaveBeenCalledTimes(1)
    expect(mocks.reconcileRows.mock.calls.at(-1)?.[2]).toMatchObject({ pushStatus: 'integrated', integrationStatus: 'merged' })
  })
  it.each(['failed', 'pending'])('does not start integration for generic %s CI evidence', async (state) => {
    const jobs = checks()
    jobs[0] = { name: CI_JOB_NAMES[0], status: state === 'pending' ? 'in_progress' : 'completed', conclusion: 'failure' }
    mocks.checks.mockResolvedValue({ headSha: sha, checks: jobs })
    await POST(request())
    expect(mocks.appToken).not.toHaveBeenCalled()
    expect(mocks.merge).not.toHaveBeenCalled()
  })
  it('does not invoke the integration controller inside the 45-second receipt cache', async () => {
    mocks.cached.mockResolvedValue({ observedAt: new Date().toISOString() })
    await POST(request())
    expect(mocks.checks).not.toHaveBeenCalled()
    expect(mocks.appToken).not.toHaveBeenCalled()
  })
  it('defers integration when its protection configuration cannot be read', async () => {
    mocks.meta.mockRejectedValue(new Error('Configuration unavailable'))
    expect((await POST(request())).status).toBe(200)
    expect(mocks.trustedChecks).not.toHaveBeenCalled()
    expect(mocks.merge).not.toHaveBeenCalled()
    expect(mocks.reconcileRows).not.toHaveBeenCalled()
    expect(mocks.writeMeta).not.toHaveBeenCalled()
    expect(mocks.save.mock.calls.at(-1)?.[1]).toMatchObject({ state: 'passed' })
  })
  it.each(['other-owner', 'other-project', 'revoked-device'])('refuses %s before privileged GitHub reads', async (reason) => {
    if (reason === 'revoked-device') mocks.auth.mockResolvedValue({ ok: false })
    else mocks.project.mockResolvedValue({ id: reason === 'other-project' ? 'other' : projectId, user_id: reason === 'other-owner' ? 'other' : 'owner' })
    expect((await POST(request())).status).toBe(reason === 'revoked-device' ? 401 : 403)
    expect(mocks.appToken).not.toHaveBeenCalled()
    expect(mocks.checks).not.toHaveBeenCalled()
  })
  it.each(['manual-branch', 'missing-pr', 'integrated'])('ignores %s checkpoints for retry', async (reason) => {
    if (reason === 'manual-branch') current.integrationBranch = 'feature/manual'
    if (reason === 'missing-pr') current.prNumber = 0
    if (reason === 'integrated') current.pushStatus = 'integrated'
    await POST(request())
    expect(mocks.appToken).not.toHaveBeenCalled()
    expect(mocks.merge).not.toHaveBeenCalled()
  })
  it.each(['changed-head', 'different-branch', 'closed-pr'])('does not act on %s', async (reason) => {
    mocks.pr.mockResolvedValue({ headSha: reason === 'changed-head' ? 'c'.repeat(40) : sha,
      headRef: reason === 'different-branch' ? 'supremo/other' : initial.integrationBranch,
      state: reason === 'closed-pr' ? 'closed' : 'open', merged: false, nodeId: 'node' })
    await POST(request())
    expect(mocks.merge).not.toHaveBeenCalled()
    expect(mocks.reconcileRows).not.toHaveBeenCalled()
  })
  it('rechecks the checkpoint after validation before allowing the merge', async () => {
    mocks.policy.mockImplementation(async () => { current = { ...current, id: 'new-checkpoint', publishedSha: 'c'.repeat(40) }; return { approved: true, headSha: sha, reasons: [] } })
    await POST(request())
    expect(mocks.merge).not.toHaveBeenCalled()
    expect(mocks.reconcileRows).not.toHaveBeenCalled()
  })
  it('recognizes a concurrent confirmed merge without a duplicate merge request', async () => {
    mocks.policy.mockImplementation(async () => { merged = true; return { approved: true, headSha: sha, reasons: [] } })
    await POST(request())
    expect(mocks.merge).not.toHaveBeenCalled()
    expect(mocks.reconcileRows.mock.calls[0]?.[2]).toMatchObject({ pushStatus: 'integrated', integrationStatus: 'merged' })
  })
  it('does not downgrade project metadata if another reconciler confirms integration meanwhile', async () => {
    mocks.scanning.mockResolvedValue({ status: 'pending', headSha: sha, reasons: ['Still checking'] })
    mocks.reconcileRows.mockImplementation(async () => { current.pushStatus = 'integrated' })
    await POST(request())
    expect(mocks.writeMeta).not.toHaveBeenCalled()
    expect(mocks.merge).not.toHaveBeenCalled()
  })
  it.each(['security_blocked', null])('pins the project update to the captured state %s even after the final checkpoint read', async (integrationState) => {
    mocks.meta.mockResolvedValue({ mergeMode: 'supremo_managed', integrationState })
    mocks.scanning.mockResolvedValue({ status: 'pending', headSha: sha, reasons: ['Still checking'] })
    await POST(request())
    expect(mocks.writeMeta).toHaveBeenCalledWith(projectId, { integration_state: 'ci_running' }, { expectedState: integrationState })
    expect(mocks.merge).not.toHaveBeenCalled()
  })
})
