import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ auth: vi.fn(), secretStore: vi.fn(), vaultStore: vi.fn(), apply: vi.fn(), available: vi.fn(), credentials: vi.fn(), revoke: vi.fn(), requests: vi.fn(), tracked:vi.fn() }))
vi.mock('@/lib/supabase/admin', () => ({ createServiceClient: () => ({ service: true }) }))
vi.mock('@/lib/checkpoint/devices', () => ({ authenticateDeviceSecret: mocks.auth }))
vi.mock('@/lib/checkpoint/store', () => ({ supabaseCheckpointDeviceStore: () => ({}) }))
vi.mock('@/lib/secret-requests/store', () => ({ secretRequestStore: mocks.secretStore }))
vi.mock('@/lib/secret-requests/service', () => ({ dismissRequestedSecret: vi.fn(), listSecretRequests: mocks.requests, requestSecrets: vi.fn() }))
vi.mock('@/lib/credentials/store', () => ({ credentialStore: mocks.vaultStore }))
vi.mock('@/lib/credentials/service', () => ({ applyCredential: mocks.apply, assertCredentialAvailable: mocks.available, listProjectCredentials: mocks.credentials, revokeCredential: mocks.revoke }))
vi.mock('@/lib/credentials/device',()=>({runDeviceCredentialOperation:mocks.tracked}))
import { POST } from './route'
const projectId = '11111111-1111-4111-8111-111111111111'
const credentialId = '22222222-2222-4222-8222-222222222222'
const requestId = '33333333-3333-4333-8333-333333333333'
const body = { projectId, deviceSecret: 'sup_dev_ckpt_fixture' }
const request = (input: object) => new Request('https://supremo.example/api/secrets', { method: 'POST', body: JSON.stringify({ ...body, ...input }) })
beforeEach(() => {
  vi.resetAllMocks()
  mocks.auth.mockResolvedValue({ ok: true, device: { ownerUserId: 'owner',id:projectId } })
  mocks.tracked.mockResolvedValue({state:'succeeded'})
  mocks.vaultStore.mockReturnValue({ vault: true }); mocks.secretStore.mockReturnValue({ secrets: true })
  mocks.credentials.mockResolvedValue([]); mocks.requests.mockResolvedValue([])
})
describe('device vault operations', () => {
  it('rejects invalid IDs, plaintext and arbitrary owner/destination input before authentication', async () => {
    for (const input of [{ operation: 'credentials', value: 'private-value' }, { operation: 'apply', credentialId, requestId, userId: 'foreign' }, { operation: 'apply', credentialId: 'bad', requestId }, { operation: 'revoke-credential', credentialId,operationId:requestId, target: 'vercel' }]) {
      const response = await POST(request(input)); expect(response.status).toBe(400); expect(await response.text()).not.toContain('private-value')
    }
    expect(mocks.auth).not.toHaveBeenCalled()
  })
  it('refuses revoked devices before vault lookup for every operation', async () => {
    mocks.auth.mockResolvedValue({ ok: false })
    for (const input of [{ operation: 'credentials' }, { operation: 'apply', credentialId, requestId }, { operation: 'revoke-credential', credentialId,operationId:requestId }]) expect((await POST(request(input))).status).toBe(401)
    expect(mocks.vaultStore).not.toHaveBeenCalled()
  })
  it('uses authenticated owner scope and returns noncacheable metadata', async () => {
    const response = await POST(request({ operation: 'credentials' }))
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({ projectId, credentials: [] })
    expect(mocks.vaultStore).toHaveBeenCalledWith({ service: true }, 'owner', projectId)
    expect(mocks.secretStore).not.toHaveBeenCalled()
  })
  it('applies opaque refs through delivery guard and returns requests after completion', async () => {
    const response = await POST(request({ operation: 'apply', credentialId, requestId }))
    expect(response.status).toBe(200)
    expect(mocks.tracked).toHaveBeenCalledWith(expect.objectContaining({ownerId:'owner',projectId,deviceId:projectId}),{operation:'apply',credentialId,requestId})
    expect(await response.json()).toEqual({ projectId,receipt:{state:'succeeded'}, requests: [], formPath: `/projects/${projectId}#secrets` })
  })
  it('removes only the specified vault ref and returns remaining metadata', async () => {
    expect((await POST(request({ operation: 'revoke-credential', credentialId,operationId:requestId }))).status).toBe(200)
    expect(mocks.tracked).toHaveBeenCalledWith(expect.objectContaining({ownerId:'owner',projectId}),{operation:'revoke-credential',credentialId,operationId:requestId})
    expect(mocks.apply).not.toHaveBeenCalled()
  })
  it('does not report completion or echo errors when reuse fails', async () => {
    mocks.tracked.mockRejectedValue(new Error('private-value ciphertext'))
    const response = await POST(request({ operation: 'apply', credentialId, requestId }))
    expect(response.status).toBe(409); expect(await response.text()).not.toMatch(/private-value|ciphertext/)
    expect(mocks.requests).not.toHaveBeenCalled()
  })
})
