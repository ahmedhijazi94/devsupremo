import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ auth: vi.fn(), authorize: vi.fn(), list: vi.fn(), resolve: vi.fn(), insert: vi.fn(), store: vi.fn() }))
vi.mock('@/lib/supabase/admin', () => ({ createServiceClient: () => ({}) }))
vi.mock('@/lib/checkpoint/devices', () => ({ authenticateDeviceSecret: mocks.auth }))
vi.mock('@/lib/checkpoint/store', () => ({ supabaseCheckpointDeviceStore: () => ({}) }))
vi.mock('@/lib/secret-requests/store', () => ({ secretRequestStore: mocks.store }))
import { POST } from './route'
import { SecretRequestError } from '@/lib/secret-requests/policy'
import { secretRequestStorageError } from '@/lib/secret-requests/storage-errors'
const projectId = '11111111-1111-4111-8111-111111111111'
const row = { id: '22222222-2222-4222-8222-222222222222', name: 'PAYMENT_API_KEY', description: 'Backend', target: 'supabase', environment: 'development', targetRef: 'projectref', accountId: 'private-account', status: 'pending' }
const entry = { name: row.name, description: row.description, target: row.target, environment: row.environment }
const body = { projectId, deviceSecret: 'sup_dev_ckpt_fixture', operation: 'status' }
const request = (payload: unknown = body) => new Request('https://supremo.example/api/secrets', { method: 'POST', body: JSON.stringify(payload) })
beforeEach(() => {
  vi.resetAllMocks()
  mocks.auth.mockResolvedValue({ ok: true, device: { ownerUserId: 'owner' } })
  mocks.authorize.mockResolvedValue(undefined)
  mocks.list.mockResolvedValue([row])
  mocks.resolve.mockResolvedValue({ target: row.target, environment: row.environment, targetRef: row.targetRef, accountId: row.accountId })
  mocks.insert.mockResolvedValue(undefined)
  mocks.store.mockReturnValue({ authorize: mocks.authorize, list: mocks.list, resolve: mocks.resolve, insert: mocks.insert })
})
describe('secret requests device endpoint', () => {
  it('rejects raw values, arbitrary destinations and oversized input before device lookup', async () => {
    for (const payload of [{ ...body, value: 'private-value' }, { ...body, operation: 'request', requests: [{ ...entry, value: 'private-value' }] }, { ...body, operation: 'request', requests: [{ ...entry, targetRef: 'foreign' }] }, { ...body, x: 'x'.repeat(33000) }]) {
      const response = await POST(request(payload)); expect([400, 413]).toContain(response.status); expect(await response.text()).not.toContain('private-value')
    }
    expect(mocks.auth).not.toHaveBeenCalled()
    const malformed = new Request('https://supremo.example/api/secrets', { method: 'POST', body: '{' })
    expect((await POST(malformed)).status).toBe(400)
  })
  it('refuses unknown/revoked devices before reading project data', async () => {
    mocks.auth.mockResolvedValue({ ok: false, reason: 'revoked' })
    expect((await POST(request())).status).toBe(401)
    expect(mocks.store).not.toHaveBeenCalled()
  })
  it('scopes every operation to the authenticated owner, refusing a foreign project before metadata reads', async () => {
    mocks.authorize.mockRejectedValue(new SecretRequestError('Projeto não autorizado.'))
    expect((await POST(request())).status).toBe(409)
    expect(mocks.store).toHaveBeenCalledWith({}, 'owner', projectId)
    expect(mocks.list).not.toHaveBeenCalled()
    expect(mocks.insert).not.toHaveBeenCalled()
  })
  it('returns only metadata and a server project form path; legacy unbound rows are omitted', async () => {
    mocks.list.mockResolvedValue([row, { ...row, id: 'old', targetRef: null }, { ...row, id: 'legacy', target: null }])
    const response = await POST(request())
    expect(response.headers.get('cache-control')).toBe('no-store')
    const output = await response.json()
    expect(output).toEqual({ projectId, formPath: `/projects/${projectId}#secrets`, requests: [{ id: row.id, name: row.name, description: row.description, target: row.target, environment: row.environment, targetRef: row.targetRef, status: row.status }] })
    expect(JSON.stringify(output)).not.toMatch(/deviceSecret|private-account|sup_dev_ckpt/)
  })
  it('registers a new named request without handling a secret value', async () => {
    mocks.list.mockResolvedValueOnce([]).mockResolvedValueOnce([row])
    expect((await POST(request({ ...body, operation: 'request', requests: [entry] }))).status).toBe(200)
    expect(mocks.insert).toHaveBeenCalledWith([{ ...entry, targetRef: row.targetRef, accountId: row.accountId }])
  })
  it('sanitizes infrastructure failures instead of returning provider credentials', async () => {
    mocks.list.mockRejectedValue(new Error('token=private-value'))
    const response = await POST(request()); expect(response.status).toBe(409); expect(await response.text()).not.toContain('private-value')
  })
  it('exposes the safe failure category to the device without disguising access denial as migration failure', async () => {
    mocks.list.mockRejectedValue(secretRequestStorageError({ code: '42501', message: 'private-value' }))
    const response = await POST(request())
    expect(response.status).toBe(409)
    const output = await response.json()
    expect(output.errorCode).toBe('access_denied')
    expect(JSON.stringify(output)).not.toMatch(/private-value|migration/)
    expect(mocks.insert).not.toHaveBeenCalled()
  })
})
