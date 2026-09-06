import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
  auth: vi.fn(), project: vi.fn(), latest: vi.fn(), credentials: vi.fn(),
  cached: vi.fn(), save: vi.fn(), envelope: vi.fn(), checks: vi.fn(), logs: vi.fn(),
}))
vi.mock('@/lib/supabase/admin', () => ({ createServiceClient: () => ({}) }))
vi.mock('@/lib/checkpoint/devices', () => ({ authenticateDeviceSecret: mocks.auth }))
vi.mock('@/lib/checkpoint/store', () => ({ supabaseCheckpointDeviceStore: () => ({}), getLatestKnownCheckpoint: mocks.latest }))
vi.mock('@/lib/checkpoint/feedback-store', () => ({ readCheckpointFeedback: mocks.cached, saveCheckpointFeedback: mocks.save, readFeedbackEnvelope: mocks.envelope }))
vi.mock('@/lib/projects/repository', () => ({ getProject: mocks.project, getGithubCredentials: mocks.credentials, NotFoundError: class NotFoundError extends Error {} }))
vi.mock('@/lib/github/client', () => ({ getChecks: mocks.checks, getFailedJobLogs: mocks.logs }))
vi.mock('@/lib/github/reconcile', () => ({ resolveRequiredChecks: () => ['coverage'] }))
import { POST } from './route'
import { NotFoundError } from '@/lib/projects/repository'

const projectId = '11111111-1111-4111-8111-111111111111'
const checkpointId = '22222222-2222-4222-8222-222222222222'
const latest = { id: checkpointId, commitSha: 'a'.repeat(40), publishedSha: 'b'.repeat(40), pushStatus: 'published' }
const request = (body: unknown = { projectId, deviceSecret: 'sup_dev_ckpt_test' }) => new Request('http://localhost/api/checkpoint/feedback', { method: 'POST', body: JSON.stringify(body) })
beforeEach(() => {
  vi.resetAllMocks()
  mocks.auth.mockResolvedValue({ ok: true, device: { ownerUserId: 'owner' } })
  mocks.project.mockResolvedValue({ id: projectId })
  mocks.latest.mockResolvedValue(latest)
  mocks.cached.mockResolvedValue(null)
  mocks.credentials.mockResolvedValue({ token: 'private-credential' })
  mocks.checks.mockResolvedValue({ headSha: latest.publishedSha, checks: [{ name: 'coverage', status: 'completed', conclusion: 'failure' }] })
  mocks.logs.mockResolvedValue('Coverage 70% < 80%\ntoken=private-credential')
  mocks.envelope.mockResolvedValue({ current: null, previousFailure: null })
})
describe('device feedback endpoint', () => {
  it('rejects invalid input and revoked devices before accessing project data', async () => {
    expect((await POST(request({ projectId: 'invalid' }))).status).toBe(400)
    expect(mocks.auth).not.toHaveBeenCalled()
    mocks.auth.mockResolvedValue({ ok: false })
    expect((await POST(request())).status).toBe(401)
    expect(mocks.project).not.toHaveBeenCalled()
    expect(mocks.checks).not.toHaveBeenCalled()
  })
  it('rejects another owner before any checkpoint or GitHub read', async () => {
    mocks.project.mockRejectedValue(new NotFoundError('not found'))
    expect((await POST(request())).status).toBe(403)
    expect(mocks.project).toHaveBeenCalledWith('owner', projectId)
    expect(mocks.latest).not.toHaveBeenCalled()
    expect(mocks.credentials).not.toHaveBeenCalled()
  })
  it('pins diagnosis to the server SHA, sanitizes evidence and rereads latest after I/O', async () => {
    const response = await POST(request())
    expect(response.status).toBe(200)
    expect(mocks.checks).toHaveBeenCalledWith({ token: 'private-credential' }, latest.publishedSha)
    expect(mocks.save.mock.calls[0]?.[1]).toMatchObject({ projectId, checkpointId, publishedSha: latest.publishedSha, state: 'failed' })
    expect(JSON.stringify(mocks.save.mock.calls)).not.toContain('private-credential')
    expect(mocks.latest).toHaveBeenCalledTimes(2)
  })
  it('serves recent evidence without a new GitHub request', async () => {
    mocks.cached.mockResolvedValue({ observedAt: new Date().toISOString() })
    expect((await POST(request())).status).toBe(200)
    expect(mocks.credentials).not.toHaveBeenCalled()
  })
  it('preserves the confirmed failure when the detailed log is unavailable', async () => {
    mocks.logs.mockRejectedValue(new Error('token=private-credential'))
    expect((await POST(request())).status).toBe(200)
    expect(mocks.save.mock.calls[0]?.[1]).toMatchObject({ state: 'failed', evidence: expect.stringContaining('indisponível') })
    expect(JSON.stringify(mocks.save.mock.calls)).not.toContain('private-credential')
  })
  it('returns unknown/unavailable instead of manufacturing success or leaking upstream secrets', async () => {
    mocks.checks.mockRejectedValue(new Error('token=private-credential'))
    const response = await POST(request())
    expect(response.status).toBe(503)
    expect(await response.text()).not.toContain('private-credential')
    expect(mocks.save).not.toHaveBeenCalled()
  })
  it('does not fetch checks for an unpublished checkpoint', async () => {
    mocks.latest.mockResolvedValue({ ...latest, publishedSha: null })
    expect((await POST(request())).status).toBe(200)
    expect(mocks.credentials).not.toHaveBeenCalled()
  })
})
