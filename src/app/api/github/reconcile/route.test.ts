import { beforeEach, describe, expect, it, vi } from 'vitest'
const candidates = vi.fn()
const persist = vi.fn()
const writeMeta = vi.fn()
const getPr = vi.fn()
const getProject = vi.fn()
const latest = vi.fn()
vi.mock('@/lib/github/app', () => ({ appTokenForRepo: async () => 'test', installationCreds: () => ({}) }))
vi.mock('@/lib/github/gateway', () => ({ githubMergeGateway: () => ({ getPullRequest: getPr }) }))
vi.mock('@/lib/supabase/admin', () => ({ createServiceClient: () => ({}) }))
vi.mock('@/lib/checkpoint/feedback-capture', () => ({ capturePrFeedback: async () => {} }))
vi.mock('@/lib/checkpoint/store', () => ({ listPendingCheckpointReconciliations: (...args: unknown[]) => candidates(...args),
  getLatestKnownCheckpoint: (...args: unknown[]) => latest(...args), reconcileCheckpointsForPr: (...args: unknown[]) => persist(...args) }))
vi.mock('@/lib/projects/repository', () => ({ getProjectById: (...args: unknown[]) => getProject(...args),
  readIntegrationMeta: async () => ({}), writeIntegrationMeta: (...args: unknown[]) => writeMeta(...args) }))
const { GET } = await import('./route')
beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv('CRON_SECRET','test-cron-placeholder')
  candidates.mockResolvedValue([{ projectId: 'p', prNumber: 7 }])
  getProject.mockResolvedValue({ id: 'p', activeBranch: 'main', defaultBranch: 'main', repoFullName: 'owner/repo' })
  getPr.mockResolvedValue({ merged: true, state: 'closed', headSha: 'a'.repeat(40), headRef: 'supremo/cp-a' })
  latest.mockResolvedValue({ prNumber: 7 })
})
describe('fallback discovers the durable checkpoint PR, even without a webhook', () => {
  it('reconciles a closed merged PR although the project still points to main', async () => {
    const response = await GET(new Request('http://localhost/api/github/reconcile', { headers: { authorization: 'Bearer test-cron-placeholder' } }))
    expect(await response.json()).toMatchObject({ reconciled: 1 })
    expect(getPr).toHaveBeenCalledWith(7)
    expect(persist).toHaveBeenCalledWith({}, { projectId: 'p', prNumber: 7, publishedSha: 'a'.repeat(40) },
      { pushStatus: 'integrated', integrationStatus: 'merged' })
    expect(writeMeta).toHaveBeenCalledWith('p', { integration_state: 'merged' })
  })
  it('an older PR cannot overwrite the project status for its newer PR', async () => {
    latest.mockResolvedValue({ prNumber: 8 })
    await GET(new Request('http://localhost/api/github/reconcile', { headers: { authorization: 'Bearer test-cron-placeholder' } }))
    expect(persist).toHaveBeenCalledTimes(1)
    expect(writeMeta).not.toHaveBeenCalled()
  })
  it('rejects unauthenticated sweep before reading projects', async () => {
    expect((await GET(new Request('http://localhost/api/github/reconcile'))).status).toBe(401)
    expect(candidates).not.toHaveBeenCalled()
  })
})
