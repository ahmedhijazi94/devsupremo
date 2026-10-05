import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ owner: vi.fn(), store: vi.fn(), authorize: vi.fn(), resolve: vi.fn(), list: vi.fn(), insert: vi.fn() }))
vi.mock('@/lib/auth', () => ({ requireProjectOwner: mocks.owner }))
vi.mock('@/lib/supabase/admin', () => ({ createServiceClient: () => ({ service: true }) }))
vi.mock('@/lib/secret-requests/store', () => ({ secretRequestStore: mocks.store }))
import { requestAuthProvider } from './auth-provider-request'
import type { SecretEntry, SecretRequestRecord } from '@/lib/secret-requests/policy'

const projectId = '11111111-1111-4111-8111-111111111111'
const requestId = '22222222-2222-4222-8222-222222222222'
const input = { projectId, expectedRef: 'owned-ref', provider: 'google' as const, clientId: 'public-client', environment: 'development' as const }
const binding = { target: 'supabase', environment: 'development', targetRef: 'owned-ref', accountId: 'owner-account' }
let rows: SecretRequestRecord[]
beforeEach(() => {
  vi.resetAllMocks()
  rows = []
  mocks.owner.mockResolvedValue({ user: { id: 'owner' } })
  mocks.resolve.mockResolvedValue(binding)
  mocks.list.mockImplementation(async () => rows)
  mocks.insert.mockImplementation(async (entries: SecretEntry[]) => { rows = entries.map(entry => ({ ...entry, ...binding, id: requestId, status: 'pending' })) as SecretRequestRecord[] })
  mocks.store.mockReturnValue(mocks)
})

describe('owner OAuth provider setup', () => {
  it.each(['google', 'github'] as const)('prepares only %s metadata through the owner-bound store', async provider => {
    expect(await requestAuthProvider({ ...input, provider })).toEqual({ ok: true, requestId, status: 'pending' })
    expect(mocks.owner).toHaveBeenCalledWith(projectId, 'id,user_id')
    expect(mocks.store).toHaveBeenCalledWith({ service: true }, 'owner', projectId)
    expect(rows[0]).toMatchObject({ name: `AUTH_${provider.toUpperCase()}_CLIENT_SECRET`, targetRef: 'owned-ref', environment: 'development',
      configuration: { kind: 'supabase-auth-provider', provider, clientId: 'public-client' } })
    expect(mocks.authorize).toHaveBeenCalledTimes(2)
    expect(mocks.resolve).toHaveBeenCalledWith(expect.objectContaining({ target: 'supabase', environment: 'development' }))
  })
  it.each([{ projectId: 'invalid' }, { provider: 'unknown' }, { clientId: 'bad id' }, { expectedRef: '../foreign' }, { environment: 'unknown' },
    { value: 'private-value' }, { clientSecret: 'private-value' }, { ownerId: requestId }])('rejects invalid or secret-bearing metadata before authorization: %j', async patch => {
    expect(await requestAuthProvider({ ...input, ...patch } as Parameters<typeof requestAuthProvider>[0])).toHaveProperty('error')
    expect(mocks.owner).not.toHaveBeenCalled()
    expect(mocks.insert).not.toHaveBeenCalled()
  })
  it('requires current session ownership before constructing a privileged store', async () => {
    mocks.owner.mockRejectedValue(new Error('private upstream failure'))
    const result = await requestAuthProvider(input)
    expect(result.error).toBeTruthy()
    expect(JSON.stringify(result)).not.toContain('private upstream failure')
    expect(mocks.store).not.toHaveBeenCalled()
  })
  it.each([{ targetRef: 'relinked' }, { environment: 'production' }, { target: 'vercel' }])('refuses a changed destination before creating a request: %j', async patch => {
    mocks.resolve.mockResolvedValue({ ...binding, ...patch })
    expect(await requestAuthProvider(input)).toMatchObject({ error: expect.stringContaining('vínculo do banco mudou') })
    expect(mocks.insert).not.toHaveBeenCalled()
  })
  it('reuses the exact request, but does not silently replace an existing client or completed field', async () => {
    await requestAuthProvider(input)
    mocks.insert.mockClear()
    expect(await requestAuthProvider(input)).toMatchObject({ ok: true, status: 'pending' })
    rows[0]!.status = 'fulfilled'
    expect(await requestAuthProvider(input)).toMatchObject({ ok: true, status: 'fulfilled' })
    expect(await requestAuthProvider({ ...input, clientId: 'another-client' })).toHaveProperty('error')
    expect(mocks.insert).not.toHaveBeenCalled()
  })
})
