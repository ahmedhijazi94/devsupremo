import type { SupabaseClient } from '@supabase/supabase-js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StorageProvider } from './service'
const mocks = vi.hoisted(() => ({ project: vi.fn(), credentials: vi.fn(), environment: vi.fn(), policy: vi.fn(), claim: vi.fn(), update: vi.fn(), factory: vi.fn() }))
vi.mock('../projects/repository', () => ({ getProject: mocks.project, getSupabaseCredentials: mocks.credentials }))
vi.mock('../database-environment/store', () => ({ readEnvironment: mocks.environment }))
vi.mock('../backend-operations/server', () => ({ authorizeProjectOperation: mocks.policy }))
vi.mock('../backend-operations/store', () => ({ backendOperationStore: () => ({ claim: mocks.claim, update: mocks.update }) }))
vi.mock('./provider', () => ({ supabaseStorageProvider: mocks.factory }))
import { runAuthorizedStorage } from './server'
const owner = '11111111-1111-4111-8111-111111111111', projectId = '22222222-2222-4222-8222-222222222222', operationId = '33333333-3333-4333-8333-333333333333'
const target = { environment: 'development' as const, expectedRef: 'projectref' }
const read = { ...target, operation: 'storage-list' as const, bucket: 'documents', prefix: '', offset: 0 }
const upload = { ...target, operation: 'storage-upload' as const, operationId, bucket: 'documents', path: 'a.txt', content: 'dGVzdA==', contentType: 'text/plain' }
let provider: StorageProvider, resolve: () => Promise<{ projectRef: string; token: string }>
const authority = () => ({ client: {} as SupabaseClient, ownerId: owner, projectId, deviceId: operationId, verifyIdentity: vi.fn(async () => owner) })
beforeEach(() => {
  vi.resetAllMocks()
  mocks.project.mockResolvedValue({ supabase_project_ref: target.expectedRef, supabase_account_id: 'account-1' })
  mocks.credentials.mockResolvedValue({ projectRef: target.expectedRef, token: 'private-provider-fixture' })
  mocks.environment.mockResolvedValue({ project_ref: target.expectedRef, environment: 'development', source: 'supremo_provisioned' })
  mocks.policy.mockResolvedValue({ policyId: 'policy-1', revision: 'revision-1' })
  mocks.claim.mockResolvedValue({ acquired: true, token: 'lease', receipt: { id: operationId } })
  mocks.update.mockImplementation(async (_id: string, _token: string, state: string, message: string, result?: unknown) => ({ id: operationId, state, message, result: result ?? null }))
  provider = { buckets: vi.fn(async () => []), list: vi.fn(async () => { await resolve(); return [{ name: 'a.txt' }] }), configure: vi.fn(async () => undefined), deleteBucket: vi.fn(async () => undefined), upload: vi.fn(async () => { await resolve() }), verifyUpload: vi.fn(async () => { await resolve(); return true }), download: vi.fn(async () => 'unused'), remove: vi.fn(async () => undefined), exists: vi.fn(async () => false) }
  mocks.factory.mockImplementation((callback: typeof resolve) => { resolve = callback; return provider })
})
describe('shared owner/device Storage authority', () => {
  it('binds account/ref/environment, forwards device and bucket scope and returns projected read data', async () => {
    expect(await runAuthorizedStorage(authority(), read)).toEqual({ items: [{ name: 'a.txt' }] })
    expect(mocks.policy).toHaveBeenCalledWith(expect.objectContaining({ projectId, ownerId: owner, deviceId: operationId, environment: 'development' }), 'storage.read', { rows: 1, resource: 'documents' })
    expect(mocks.claim).not.toHaveBeenCalled()
    expect(mocks.credentials).toHaveBeenCalledWith(owner, expect.objectContaining({ supabase_account_id: 'account-1' }))
  })
  it('refuses wrong identity, ref, environment and missing policy before a storage call', async () => {
    const auth = authority(); auth.verifyIdentity.mockResolvedValue(projectId)
    await expect(runAuthorizedStorage(auth, read)).rejects.toThrow('sessão mudou')
    for (const patch of [{ expectedRef: 'other' }, { environment: 'production' as const }]) await expect(runAuthorizedStorage(authority(), { ...read, ...patch })).rejects.toThrow('mudou')
    mocks.policy.mockRejectedValueOnce(new Error('no permission'))
    await expect(runAuthorizedStorage(authority(), read)).rejects.toThrow('no permission')
    expect(provider.list).not.toHaveBeenCalled()
  })
  it('rejects an account change during credential lookup and policy revision after provider response', async () => {
    mocks.credentials.mockImplementationOnce(async () => { mocks.project.mockResolvedValue({ supabase_project_ref: target.expectedRef, supabase_account_id: 'replacement' }); return { projectRef: target.expectedRef, token: 'private-provider-fixture' } })
    await expect(runAuthorizedStorage(authority(), read)).rejects.toThrow('conta')
    mocks.project.mockResolvedValue({ supabase_project_ref: target.expectedRef, supabase_account_id: 'account-1' })
    vi.mocked(provider.list).mockImplementationOnce(async () => { await resolve(); mocks.policy.mockResolvedValue({ policyId: 'policy-1', revision: 'changed' }); return [{ name: 'unconfirmed.txt' }] })
    await expect(runAuthorizedStorage(authority(), read)).rejects.toThrow('autorização mudou')
  })
  it('reserves quota and verifies bytes before a completed mutation receipt', async () => {
    expect(await runAuthorizedStorage(authority(), upload)).toMatchObject({ receipt: { state: 'succeeded', result: { contentVerified: true } } })
    expect(mocks.claim).toHaveBeenCalledWith({ policyId: 'policy-1', revision: 'revision-1' })
    expect(provider.verifyUpload).toHaveBeenCalledWith('documents', 'a.txt', 'dGVzdA==', 'text/plain')
    mocks.claim.mockRejectedValueOnce(new Error('quota exceeded'))
    await expect(runAuthorizedStorage(authority(), upload)).rejects.toThrow('quota')
    expect(provider.upload).toHaveBeenCalledOnce()
  })
  it('retains a lost upload response as uncertain and cannot dispatch the same ledger ID twice', async () => {
    vi.mocked(provider.upload).mockRejectedValueOnce(new Error('private-key provider failure'))
    const result = await runAuthorizedStorage(authority(), upload)
    expect(result).toMatchObject({ receipt: { state: 'uncertain' } }); expect(JSON.stringify(result)).not.toContain('private-key')
    mocks.claim.mockResolvedValue({ acquired: false, token: 'another', receipt: { id: operationId, state: 'uncertain', result: null } })
    expect(await runAuthorizedStorage(authority(), upload)).toMatchObject({ receipt: { state: 'uncertain' } })
    expect(provider.upload).toHaveBeenCalledOnce()
  })
  it('does not publish success after verification changes policy or observed bytes differ', async () => {
    vi.mocked(provider.verifyUpload).mockImplementationOnce(async () => { mocks.policy.mockResolvedValue({ policyId: 'policy-1', revision: 'revoked' }); return true })
    expect(await runAuthorizedStorage(authority(), upload)).toMatchObject({ receipt: { state: 'uncertain' } })
    mocks.policy.mockResolvedValue({ policyId: 'policy-1', revision: 'revision-1' }); vi.mocked(provider.verifyUpload).mockResolvedValueOnce(false)
    expect(await runAuthorizedStorage(authority(), upload)).toMatchObject({ receipt: { state: 'uncertain' } })
  })
})
