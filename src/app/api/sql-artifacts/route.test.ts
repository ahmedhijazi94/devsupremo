import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ auth: vi.fn(), authority: vi.fn(), poll: vi.fn(), process: vi.fn() }))
vi.mock('@/lib/supabase/admin', () => ({ createServiceClient: () => ({}) }))
vi.mock('@/lib/checkpoint/store', () => ({ supabaseCheckpointDeviceStore: () => ({}) }))
vi.mock('@/lib/checkpoint/devices', () => ({ authenticateDeviceSecret: mocks.auth }))
vi.mock('@/lib/sql-artifacts/server', () => ({ readSqlArtifactAuthority: mocks.authority, pollSqlArtifact: mocks.poll, processSqlArtifact: mocks.process }))
import { POST } from './route'
import { SqlArtifactError } from '@/lib/sql-artifacts/contract'
const id = '11111111-1111-4111-8111-111111111111'
const input = { operation: 'poll', projectId: id, expectedRef: 'abcdefghijklmnopqrst', deviceSecret: 'test-device-authorization', sessionId: id, ready: true }
const binding = { policyId: id, revision: id, accountId: id, projectRef: input.expectedRef }
const post = (body: unknown = input) => POST(new Request('https://supremo.example/api/sql-artifacts', { method: 'POST', body: JSON.stringify(body) }))
beforeEach(() => {
  vi.resetAllMocks()
  mocks.auth.mockResolvedValue({ ok: true, device: { id, ownerUserId: id } })
  mocks.authority.mockResolvedValue(binding)
  mocks.poll.mockResolvedValue({ content: 'private migration', claimToken: 'private claim' })
})
describe('SQL artifact response authority', () => {
  it('requires a valid request and device before reserving an artifact', async () => {
    expect((await post({ ...input, ownerId: id })).status).not.toBe(200)
    expect(mocks.auth).not.toHaveBeenCalled()
    mocks.auth.mockResolvedValue({ ok: false })
    expect((await post()).status).toBe(401)
    expect(mocks.poll).not.toHaveBeenCalled()
  })
  it('rechecks the complete binding after the artifact is reserved', async () => {
    const result = await post()
    expect(result.status).toBe(200)
    expect(mocks.authority).toHaveBeenCalledTimes(2)
    expect(mocks.poll).toHaveBeenCalledWith(expect.objectContaining({ ownerId: id, deviceId: id, expectedRef: input.expectedRef }), id, true)
    expect(result.headers.get('Cache-Control')).toBe('no-store')
  })
  it.each([{ ...binding, revision: 'new-revision' }, { ...binding, accountId: 'new-account' }, { ...binding, projectRef: 'new-ref' }])('withholds SQL/types on binding change', async current => {
    mocks.authority.mockResolvedValueOnce(binding).mockResolvedValueOnce(current)
    const result = await post()
    expect(result.status).toBe(409)
    expect(await result.text()).not.toContain('private')
  })
  it('withholds a completed response after device revocation', async () => {
    mocks.authority.mockResolvedValueOnce(binding).mockRejectedValueOnce(new SqlArtifactError('Dispositivo revogado.', 401))
    const result = await post()
    expect(result.status).toBe(401)
    expect(await result.text()).not.toContain('private')
  })
})
