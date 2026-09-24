import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ owner: vi.fn(), secrets: vi.fn(), vault: vi.fn(), fulfill: vi.fn(), remember: vi.fn(), list: vi.fn(), revoke: vi.fn() }))
vi.mock('@/lib/auth', () => ({ requireProjectOwner: mocks.owner }))
vi.mock('@/lib/supabase/admin', () => ({ createServiceClient: () => ({ service: true }) }))
vi.mock('@/lib/secret-requests/store', () => ({ secretRequestStore: mocks.secrets }))
vi.mock('@/lib/secret-requests/service', async (original) => ({ ...await original<typeof import('@/lib/secret-requests/service')>(), fulfillSecret: mocks.fulfill }))
vi.mock('@/lib/credentials/store', () => ({ credentialStore: mocks.vault }))
vi.mock('@/lib/credentials/service', async (original) => ({ ...await original<typeof import('@/lib/credentials/service')>(), rememberCredential: mocks.remember, listProjectCredentials: mocks.list, revokeCredential: mocks.revoke }))
import { getProjectCredentials, revokeProjectCredential, saveSecret } from './secrets'
const projectId = '11111111-1111-4111-8111-111111111111'
const requestId = '22222222-2222-4222-8222-222222222222'
const row = { id: requestId, name: 'API_KEY', status: 'fulfilled', environment: 'development' }
const input = { projectId, requestId, value: 'private-value', remember: true }
beforeEach(() => {
  vi.resetAllMocks()
  mocks.owner.mockResolvedValue({ user: { id: 'owner' } })
  mocks.secrets.mockReturnValue({ secrets: true }); mocks.vault.mockReturnValue({ vault: true })
  mocks.fulfill.mockResolvedValue(row); mocks.list.mockResolvedValue([])
})
describe('credential owner actions', () => {
  it('requires owner session before vault reads, removals or remembering secrets', async () => {
    mocks.owner.mockRejectedValue(new Error('private-value'))
    for (const call of [getProjectCredentials(projectId), revokeProjectCredential({ projectId, credentialId: requestId }), saveSecret(input)]) {
      expect(await call).toEqual({ error: expect.not.stringContaining('private-value') })
    }
    expect(mocks.vault).not.toHaveBeenCalled(); expect(mocks.fulfill).not.toHaveBeenCalled()
  })
  it('rejects invalid IDs and metadata injection', async () => {
    expect(await getProjectCredentials('bad')).toHaveProperty('error')
    expect(await revokeProjectCredential({ projectId, credentialId: 'bad' })).toHaveProperty('error')
    expect(await revokeProjectCredential({ projectId, credentialId: requestId, value: 'raw' } as Parameters<typeof revokeProjectCredential>[0])).toHaveProperty('error')
    expect(mocks.owner).not.toHaveBeenCalled()
  })
  it('stores only after confirmed delivery and never returns the value', async () => {
    expect(await saveSecret(input)).toEqual({ ok: true, credentialSaved: true })
    expect(mocks.remember).toHaveBeenCalledWith({ vault: true }, row, input.value)
    expect(mocks.fulfill.mock.invocationCallOrder[0]).toBeLessThan(mocks.remember.mock.invocationCallOrder[0]!)
    expect(mocks.vault).toHaveBeenCalledWith({ service: true }, 'owner', projectId)
  })
  it('does not retain values without explicit opt-in, preserving old form submissions', async () => {
    expect(await saveSecret({ projectId, requestId, value: input.value })).toEqual({ ok: true })
    expect(await saveSecret({ ...input, remember: false })).toEqual({ ok: true })
    expect(mocks.remember).not.toHaveBeenCalled(); expect(mocks.vault).not.toHaveBeenCalled()
  })
  it('preserves delivery success if vault is unavailable without leaking the storage error', async () => {
    mocks.remember.mockRejectedValue(new Error('private-value sensitive database detail'))
    const result = await saveSecret(input)
    expect(result).toMatchObject({ ok: true, credentialSaved: false, warning: expect.any(String) })
    expect(result.error).toBeUndefined(); expect(JSON.stringify(result)).not.toContain('private-value')
    expect(mocks.fulfill).toHaveBeenCalledOnce()
  })
  it('never saves a value if provider delivery failed', async () => {
    mocks.fulfill.mockRejectedValue(new Error('private-value'))
    expect(await saveSecret(input)).toHaveProperty('error')
    expect(mocks.remember).not.toHaveBeenCalled()
  })
  it('enforces non-password retention validation before provider dispatch', async () => {
    mocks.fulfill.mockImplementation(async (_port, _id, _value, validate) => {
      validate({ ...row, configuration: { kind: 'supabase-user-password', userId: requestId } })
    })
    expect(await saveSecret(input)).toMatchObject({ error: expect.stringContaining('Senhas de contas') })
    expect(mocks.remember).not.toHaveBeenCalled()
  })
  it('returns metadata only and removes through the scoped service', async () => {
    expect(await getProjectCredentials(projectId)).toEqual({ credentials: [] })
    expect(await revokeProjectCredential({ projectId, credentialId: requestId })).toEqual({ ok: true })
    expect(mocks.revoke).toHaveBeenCalledWith({ vault: true }, requestId)
    mocks.revoke.mockRejectedValue(new Error('private-value'))
    expect(await revokeProjectCredential({ projectId, credentialId: requestId })).toEqual({ error: expect.not.stringContaining('private-value') })
  })
})
