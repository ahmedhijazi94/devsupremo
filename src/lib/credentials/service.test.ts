import { beforeEach, describe, expect, it, vi } from 'vitest'
import { applyCredential, assertCredentialAvailable, assertRememberable, listProjectCredentials, rememberCredential, revokeCredential, type CredentialPort, type CredentialRecord } from './service'
import { decryptCredential, encryptCredential } from './crypto'
import { credentialView } from './contract'
import type { SecretRequestPort } from '@/lib/secret-requests/service'
import { safeSecretFailure, type SecretRequestRecord } from '@/lib/secret-requests/policy'
const userId = '11111111-1111-4111-8111-111111111111'
const projectId = '22222222-2222-4222-8222-222222222222'
const id = '33333333-3333-4333-8333-333333333333'
const requestId = '44444444-4444-4444-8444-444444444444'
const scope = { id, userId, projectId, environment: 'development' as const }
const metadata = { id, name: 'RESEND_API_KEY', environment: 'development' as const, createdAt: '2026-09-24T00:00:00Z', updatedAt: '2026-09-24T00:00:00Z' }
const binding = { target: 'supabase' as const, environment: 'development' as const, targetRef: 'projectref', accountId: 'account' }
const request: SecretRequestRecord = { ...binding, id: requestId, name: 'AUTH_SMTP_PASSWORD', description: 'SMTP', status: 'pending', configuration: { kind: 'supabase-smtp', provider: 'resend', senderEmail: 'a@example.test', senderName: 'Test' } }
function fixture() {
  const credential: CredentialRecord = { ...scope, ...metadata, encryptedValue: encryptCredential('private-value', scope) }
  const vault = { userId, projectId, authorize: vi.fn(), list: vi.fn().mockResolvedValue([credential]), find: vi.fn().mockResolvedValue(credential), insert: vi.fn(), remove: vi.fn(), audit: vi.fn() } satisfies CredentialPort
  const secrets = { authorize: vi.fn(), find: vi.fn().mockResolvedValue(request), resolve: vi.fn().mockResolvedValue(binding), list: vi.fn(), insert: vi.fn(), audit: vi.fn(), claim: vi.fn().mockResolvedValue({ id: 'claim', expiresAt: '2100-01-01' }), release: vi.fn(), deliver: vi.fn(), fulfill: vi.fn(), dismiss: vi.fn() } satisfies SecretRequestPort
  return { credential, vault, secrets }
}
beforeEach(() => { vi.stubEnv('ENCRYPTION_KEY', '0'.repeat(64)) })
describe('project credential vault', () => {
  it('lists only whitelisted metadata even if an adapter includes private fields', async () => {
    const { vault, credential } = fixture()
    expect(await listProjectCredentials(vault)).toEqual([metadata])
    expect(credentialView(credential)).toEqual(metadata)
    expect(vault.authorize).toHaveBeenCalledOnce()
  })
  it('encrypts only after fulfilled delivery, never sending plaintext to persistence or audits', async () => {
    const { vault } = fixture()
    const completed = { ...request, status: 'fulfilled' as const }
    await rememberCredential(vault, completed, 'private-value')
    const saved = vault.insert.mock.calls[0]?.[0] as unknown as CredentialRecord
    expect(saved).toMatchObject({ id: requestId, name: 'AUTH_SMTP_PASSWORD', userId, projectId, environment: 'development' })
    expect(decryptCredential(saved.encryptedValue, { id: requestId, userId, projectId, environment: 'development' })).toBe('private-value')
    expect(JSON.stringify(vault.insert.mock.calls)).not.toContain('private-value')
    expect(vault.audit).toHaveBeenCalledWith('saved', requestId, requestId)
    expect(vault.authorize).toHaveBeenCalledTimes(2)
  })
  it('refuses retaining pending requests, account passwords, public names and oversized unicode', async () => {
    const { vault } = fixture()
    for (const record of [request, { ...request, status: 'fulfilled' as const, environment: null }, { ...request, status: 'fulfilled' as const, name: 'AUTH_USER_PASSWORD_X' }, { ...request, status: 'fulfilled' as const, configuration: { kind: 'supabase-user-password' as const, userId } }]) {
      await expect(rememberCredential(vault, record, 'private-value')).rejects.toThrow()
    }
    expect(() => assertRememberable({ ...request, name: 'NEXT_PUBLIC_KEY' })).toThrow()
    await expect(rememberCredential(vault, { ...request, status: 'fulfilled' }, 'á'.repeat(16384))).rejects.toThrow()
    expect(vault.insert).not.toHaveBeenCalled()
  })
  it('applies an explicitly selected credential to a differently named field in the same environment', async () => {
    const { vault, secrets } = fixture()
    await applyCredential(vault, secrets, requestId, id)
    expect(secrets.deliver).toHaveBeenCalledWith(request, binding, 'private-value', expect.any(Object))
    expect(vault.audit).toHaveBeenCalledWith('used', id, requestId)
    expect(secrets.fulfill).toHaveBeenCalledOnce()
  })
  it.each(['owner', 'project', 'environment', 'missing', 'password', 'missing-request', 'corrupt', 'audit', 'revoked'])('fails closed for %s without provider dispatch', async (scenario) => {
    const { credential, vault, secrets } = fixture()
    if (scenario === 'owner') vault.find.mockResolvedValue({ ...credential, userId: requestId })
    if (scenario === 'project') vault.find.mockResolvedValue({ ...credential, projectId: requestId })
    if (scenario === 'environment') secrets.find.mockResolvedValue({ ...request, environment: 'production' })
    if (scenario === 'missing') vault.find.mockResolvedValue(null)
    if (scenario === 'missing-request') secrets.find.mockResolvedValue(null)
    if (scenario === 'password') secrets.find.mockResolvedValue({ ...request, configuration: { kind: 'supabase-user-password', userId } })
    if (scenario === 'corrupt') vault.find.mockResolvedValue({ ...credential, encryptedValue: 'private-invalid-ciphertext' })
    if (scenario === 'audit') vault.audit.mockRejectedValue(new Error('private-error'))
    if (scenario === 'revoked') vault.find.mockResolvedValueOnce(credential).mockResolvedValue(null)
    try { await applyCredential(vault, secrets, requestId, id); expect.fail('expected failure') }
    catch (error) { expect(JSON.stringify(safeSecretFailure(error))).not.toMatch(/private-value|private-error|private-invalid/) }
    expect(secrets.deliver).not.toHaveBeenCalled()
  })
  it('rechecks the request environment during final delivery validation', async () => {
    const { vault, secrets } = fixture()
    secrets.find.mockResolvedValueOnce(request).mockResolvedValue({ ...request, environment: 'production' })
    secrets.resolve.mockResolvedValue({ ...binding, environment: 'production' })
    await expect(applyCredential(vault, secrets, requestId, id)).rejects.toThrow('outro ambiente')
    expect(secrets.claim).not.toHaveBeenCalled()
  })
  it('rejects unauthorized operations before reading metadata or decrypting', async () => {
    const { vault, secrets } = fixture()
    vault.authorize.mockRejectedValue(new Error('denied'))
    for (const op of [listProjectCredentials(vault), assertCredentialAvailable(vault, id), applyCredential(vault, secrets, requestId, id), revokeCredential(vault, id), rememberCredential(vault, { ...request, status: 'fulfilled' }, 'private-value')]) await expect(op).rejects.toThrow('denied')
    expect(vault.find).not.toHaveBeenCalled(); expect(vault.list).not.toHaveBeenCalled(); expect(vault.insert).not.toHaveBeenCalled()
  })
  it('deletes only from vault, is idempotent and does not silently erase provider configuration', async () => {
    const { vault, secrets } = fixture()
    await revokeCredential(vault, id)
    expect(vault.audit).toHaveBeenCalledWith('removed', id)
    expect(vault.remove).toHaveBeenCalledWith(id)
    expect(secrets.deliver).not.toHaveBeenCalled()
    vault.find.mockResolvedValue(null); vault.remove.mockClear()
    await revokeCredential(vault, id)
    expect(vault.remove).not.toHaveBeenCalled()
  })
})
