import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ owner: vi.fn(), store: vi.fn(), authorize: vi.fn(), find: vi.fn(), resolve: vi.fn(), deliver: vi.fn(), audit: vi.fn(), fulfill: vi.fn(), list: vi.fn(), dismiss: vi.fn() }))
vi.mock('@/lib/auth', () => ({ requireProjectOwner: mocks.owner }))
vi.mock('@/lib/supabase/admin', () => ({ createServiceClient: () => ({ service: true }) }))
vi.mock('@/lib/secret-requests/store', () => ({ secretRequestStore: mocks.store }))
import { dismissSecretRequest, getSecretRequests, saveSecret } from './secrets'
import { secretRequestStorageError } from '@/lib/secret-requests/storage-errors'
const projectId = '11111111-1111-4111-8111-111111111111'
const requestId = '22222222-2222-4222-8222-222222222222'
const binding = { target: 'supabase', environment: 'development', targetRef: 'projectref', accountId: 'account' }
const row = { ...binding, id: requestId, name: 'PAYMENT_API_KEY', description: 'Backend', status: 'pending' }
beforeEach(() => {
  vi.resetAllMocks()
  mocks.owner.mockResolvedValue({ user: { id: 'owner' }, supabase: {} })
  mocks.authorize.mockResolvedValue(undefined)
  mocks.find.mockResolvedValue(row); mocks.resolve.mockResolvedValue(binding); mocks.list.mockResolvedValue([row])
  mocks.store.mockReturnValue(mocks)
})
describe('secret owner actions', () => {
  it('requires session ownership for reads, writes and dismissal', async () => {
    mocks.owner.mockRejectedValue(new Error('session unavailable private-value'))
    for (const promise of [getSecretRequests(projectId), saveSecret({ projectId, requestId, value: 'private-value' }), dismissSecretRequest({ projectId, requestId })]) {
      const result = await promise; expect(result.error).toBeTruthy(); expect(JSON.stringify(result)).not.toContain('private-value')
    }
    expect(mocks.store).not.toHaveBeenCalled()
    expect(mocks.deliver).not.toHaveBeenCalled()
  })
  it('rejects destination/name injection and invalid values before authorization', async () => {
    expect(await saveSecret({ projectId, requestId, value: 'private', name: 'FOREIGN_KEY' } as Parameters<typeof saveSecret>[0])).toHaveProperty('error')
    expect(await saveSecret({ projectId, requestId, value: '' })).toHaveProperty('error')
    expect(await getSecretRequests('bad')).toHaveProperty('error')
    expect(await dismissSecretRequest({ projectId, requestId: 'bad' })).toHaveProperty('error')
    expect(mocks.owner).not.toHaveBeenCalled()
  })
  it('looks up destination by the existing request ID and never returns the submitted value', async () => {
    const result = await saveSecret({ projectId, requestId, value: 'private-value' })
    expect(result).toEqual({ ok: true }); expect(mocks.find).toHaveBeenCalledWith(requestId)
    expect(mocks.store).toHaveBeenCalledWith({ service: true }, 'owner', projectId)
    expect(mocks.deliver).toHaveBeenCalledWith(row, binding, 'private-value')
    expect(mocks.fulfill).toHaveBeenCalledWith(row)
    expect(await getSecretRequests(projectId)).toEqual({ requests: [{ id: requestId, name: row.name, description: row.description, target: row.target, environment: row.environment, targetRef: row.targetRef, status: 'pending' }] })
    expect(await dismissSecretRequest({ projectId, requestId })).toEqual({ ok: true })
    expect(mocks.dismiss).toHaveBeenCalledWith(requestId)
  })
  it('reports provider and database failures without leaking values or claiming success', async () => {
    mocks.deliver.mockRejectedValue(new Error('provider returned private-value'))
    expect(await saveSecret({ projectId, requestId, value: 'private-value' })).toEqual({ error: expect.not.stringContaining('private-value') })
    expect(mocks.fulfill).not.toHaveBeenCalled()
    mocks.dismiss.mockRejectedValue(new Error('database private-value'))
    expect(await dismissSecretRequest({ projectId, requestId })).toEqual({ error: expect.not.stringContaining('private-value') })
  })
  it('returns a classified database failure and recovers after schema availability without changing authorization', async () => {
    mocks.list.mockRejectedValueOnce(secretRequestStorageError({ code: '42703', message: 'private-value' }))
    const failed = await getSecretRequests(projectId)
    expect(failed.errorCode).toBe('schema_unavailable')
    expect(failed.requests).toBeUndefined()
    expect(JSON.stringify(failed)).not.toContain('private-value')
    const recovered = await getSecretRequests(projectId)
    expect(recovered.requests).toHaveLength(1)
    expect(recovered.error).toBeUndefined()
    expect(mocks.owner).toHaveBeenCalledTimes(2)
    expect(mocks.deliver).not.toHaveBeenCalled()
  })
})
