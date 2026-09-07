import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ authenticate: vi.fn(), create: vi.fn(), report: vi.fn() }))
vi.mock('@/lib/supabase/admin', () => ({ createServiceClient: mocks.create }))
vi.mock('@/lib/checkpoint/devices', () => ({ authenticateDeviceSecret: mocks.authenticate }))
vi.mock('@/lib/checkpoint/store', () => ({ reportLocalCheckpoint: mocks.report, supabaseCheckpointDeviceStore: vi.fn() }))
import { POST } from '@/app/api/checkpoint/local-report/route'

const payload = {
  deviceSecret: 'device-example-not-a-credential',
  projectId: '11111111-1111-4111-8111-111111111111',
  checkpointId: '22222222-2222-4222-8222-222222222222',
  commitSha: 'a'.repeat(40), createdAt: '2026-09-06T00:00:00.000Z', revision: 3,
  validationStatus: 'failed', validatedSha: 'a'.repeat(40), uploadStatus: 'local',
}
function clientFor(owner: string | null, error: unknown = null) {
  const chain = { from: vi.fn(), select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn(async () => ({ data: owner ? { id: payload.projectId, user_id: owner } : null, error })) }
  chain.from.mockReturnValue(chain); chain.select.mockReturnValue(chain); chain.eq.mockReturnValue(chain)
  return chain
}
const send = (body: unknown = payload) => POST(new Request('https://supremo.test/api/checkpoint/local-report', { method: 'POST', body: JSON.stringify(body) }))

describe('local checkpoint route authorization and failure handling', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.create.mockReturnValue(clientFor('owner'))
    mocks.authenticate.mockResolvedValue({ ok: true, device: { id: 'device', ownerUserId: 'owner' } })
    mocks.report.mockResolvedValue('recorded')
  })
  it('registers failed metadata independently, with the authenticated device identity', async () => {
    const response = await send()
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ reported: true })
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(mocks.report).toHaveBeenCalledWith(expect.anything(), 'device', payload)
  })
  it('invalid payload does not reach credentials or persistence', async () => {
    expect((await send({ ...payload, source: 'private file' })).status).toBe(400)
    expect(mocks.authenticate).not.toHaveBeenCalled()
    expect(mocks.report).not.toHaveBeenCalled()
  })
  it('revoked/unrecognized devices cannot register', async () => {
    mocks.authenticate.mockResolvedValue({ ok: false })
    expect((await send()).status).toBe(401)
    expect(mocks.report).not.toHaveBeenCalled()
  })
  it.each([null, 'another-owner'])('missing and foreign projects give the same refusal (%s)', async (owner) => {
    mocks.create.mockReturnValue(clientFor(owner))
    const response = await send()
    expect(response.status).toBe(403)
    expect(mocks.report).not.toHaveBeenCalled()
  })
  it('does not acknowledge a database outage', async () => {
    mocks.create.mockReturnValue(clientFor('owner', new Error('db unavailable')))
    expect((await send()).status).toBe(503)
    expect(mocks.report).not.toHaveBeenCalled()
  })
  it('rejects checkpoint identity/SHA conflict and acknowledges harmless stale retries', async () => {
    mocks.report.mockResolvedValueOnce('conflict').mockResolvedValueOnce('ignored')
    expect((await send()).status).toBe(409)
    expect((await send()).status).toBe(200)
  })
  it('propagates report failure as retryable without revealing diagnostics', async () => {
    mocks.report.mockRejectedValue(new Error('secret diagnostic'))
    const response = await send()
    expect(response.status).toBe(503)
    expect(await response.text()).not.toContain('secret diagnostic')
  })
})
