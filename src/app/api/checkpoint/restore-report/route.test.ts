import { beforeEach, describe, expect, it, vi } from 'vitest'
const auth = vi.fn()
const applied = vi.fn()
const failed = vi.fn()
vi.mock('@/lib/supabase/admin', () => ({ createServiceClient: () => ({}) }))
vi.mock('@/lib/checkpoint/devices', () => ({ authenticateDeviceSecret: (...args: unknown[]) => auth(...args) }))
vi.mock('@/lib/checkpoint/store', () => ({ supabaseCheckpointDeviceStore: () => ({}),
  reportRestoreApplied: (...args: unknown[]) => applied(...args), reportRestoreFailed: (...args: unknown[]) => failed(...args) }))
const { POST } = await import('./route')
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const body = { deviceSecret: 'device-placeholder', projectId: id(1), restoreRequestId: id(2), claimToken: id(3),
  status: 'applied', resultCheckpointId: id(4), resultCommitSha: 'a'.repeat(40) }
const request = (value: unknown) => new Request('http://localhost/api/checkpoint/restore-report', {
  method: 'POST', body: JSON.stringify(value), headers: { 'content-type': 'application/json' } })
beforeEach(() => { vi.clearAllMocks(); auth.mockResolvedValue({ ok: true, device: { id: id(5) } }); applied.mockResolvedValue(true); failed.mockResolvedValue(true) })
describe('restore report durable acknowledgement', () => {
  it('rejects missing lease, mismatched result id/SHA and oversized input before authentication', async () => {
    for (const invalid of [{ ...body, claimToken: undefined }, { ...body, resultCommitSha: null },
      { ...body, resultCommitSha: 'not-a-sha' }, { ...body, deviceSecret: 'x'.repeat(5000) }]) {
      expect((await POST(request(invalid))).status).toBe(400)
    }
    expect(auth).not.toHaveBeenCalled()
  })
  it('revoked device cannot report', async () => {
    auth.mockResolvedValue({ ok: false })
    expect((await POST(request(body))).status).toBe(401)
    expect(applied).not.toHaveBeenCalled()
  })
  it('passes authenticated device, project and claim identity to the atomic database operation', async () => {
    const response = await POST(request(body))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect(applied).toHaveBeenCalledWith({}, { id: id(2), projectId: id(1), deviceId: id(5), claimToken: id(3) }, id(4), 'a'.repeat(40))
  })
  it('wrong owner/device/lease or changed replay result has no successful ACK', async () => {
    applied.mockResolvedValue(false)
    expect((await POST(request(body))).status).toBe(409)
  })
  it('database FK/write failure is retryable, never false success', async () => {
    applied.mockRejectedValue(new Error('23503'))
    const response = await POST(request(body))
    expect(response.status).toBe(503)
    expect(await response.json()).not.toEqual({ ok: true })
  })
  it('failed result uses the same lease scope and propagates DB errors', async () => {
    failed.mockRejectedValue(new Error('offline'))
    const { resultCheckpointId: _id, resultCommitSha: _sha, ...common } = body
    void _id; void _sha
    expect((await POST(request({ ...common, status: 'failed', error: 'Restauração interrompida.' }))).status).toBe(503)
    expect(failed).toHaveBeenCalledWith({}, expect.objectContaining({ claimToken: id(3) }), 'Restauração interrompida.')
  })
})
