import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
const mocks = vi.hoisted(() => ({ authenticate: vi.fn(), project: vi.fn(), policy: vi.fn(), authorize: vi.fn(), storage: vi.fn(), integration: vi.fn(), proposal: vi.fn(), connections: vi.fn(), sessions: vi.fn(), proposals: vi.fn(), from: vi.fn() }))
vi.mock('@/lib/supabase/admin', () => ({ createServiceClient: () => ({ from: mocks.from }) }))
vi.mock('@/lib/checkpoint/devices', () => ({ authenticateDeviceSecret: mocks.authenticate }))
vi.mock('@/lib/checkpoint/store', () => ({ supabaseCheckpointDeviceStore: () => ({}) }))
vi.mock('@/lib/projects/repository', () => ({ getProject: mocks.project }))
vi.mock('@/lib/database-environment/store', () => ({ readEnvironment: async () => ({}) }))
vi.mock('@/lib/database-environment/policy', () => ({ describeEnvironment: () => ({ environment: 'development' }) }))
vi.mock('@/lib/backend-operations/server', () => ({ readOperationPolicy: mocks.policy, authorizeProjectOperation: mocks.authorize }))
vi.mock('@/lib/project-storage/server', () => ({ runAuthorizedStorage: mocks.storage }))
vi.mock('@/lib/integrations/server', () => ({ runAuthorizedIntegration: mocks.integration, listIntegrationSessions: mocks.sessions }))
vi.mock('@/lib/provider-connections/server', () => ({ listProviderConnections: mocks.connections }))
vi.mock('@/lib/provider-connections/proposals', () => ({ proposeIntegrationConnection: mocks.proposal, listIntegrationConnectionProposals: mocks.proposals }))
import { POST } from './route'
import { OperationError } from '@/lib/backend-operations/contract'
const projectId = '11111111-1111-4111-8111-111111111111', ownerId = '22222222-2222-4222-8222-222222222222', deviceId = '33333333-3333-4333-8333-333333333333', operationId = '44444444-4444-4444-8444-444444444444'
const input = { projectId, deviceSecret: 'test-device-authorization' }
const post = (body: Record<string, unknown>) => POST(new NextRequest('https://supremo.example/api/backend-operations', { method: 'POST', body: JSON.stringify({ ...input, ...body }) }))
beforeEach(() => {
  vi.clearAllMocks(); mocks.authenticate.mockResolvedValue({ ok: true, device: { id: deviceId, ownerUserId: ownerId } }); mocks.project.mockResolvedValue({ id: projectId, supabase_project_ref: 'ref' })
  mocks.policy.mockResolvedValue(null); mocks.storage.mockResolvedValue({ items: [] }); mocks.integration.mockResolvedValue({ status: 'verified' }); mocks.connections.mockResolvedValue([]); mocks.sessions.mockResolvedValue([]); mocks.proposals.mockResolvedValue([])
  mocks.authorize.mockResolvedValue({ policyId: operationId, revision: deviceId })
})
describe('agent backend API authority boundary', () => {
  it('validates contracts before looking up credentials or invoking providers', async () => {
    expect((await post({ operation: 'catalog', ownerId })).status).toBe(400)
    expect((await post({ operation: 'storage', options: { operation: 'storage-remove', bucket: 'files', paths: ['../file'], environment: 'development', expectedRef: 'ref', operationId } })).status).toBe(400)
    expect((await POST(new NextRequest('https://supremo.example/api/backend-operations', { method: 'POST', body: '{' }))).status).toBe(400)
    expect(mocks.authenticate).not.toHaveBeenCalled(); expect(mocks.storage).not.toHaveBeenCalled()
  })
  it('authenticates both before and after reads and never accepts the requested owner', async () => {
    mocks.authenticate.mockResolvedValueOnce({ ok: false })
    expect((await post({ operation: 'catalog' })).status).toBe(401)
    expect(mocks.project).not.toHaveBeenCalled()
    mocks.authenticate.mockResolvedValueOnce({ ok: true, device: { id: deviceId, ownerUserId: ownerId } }).mockResolvedValueOnce({ ok: false })
    expect((await post({ operation: 'policy' })).status).toBe(401)
    expect(mocks.policy).toHaveBeenCalledWith(expect.anything(), ownerId, projectId, 'development')
  })
  it('pins owner/project/device identity for storage and does not pass the device secret', async () => {
    const options = { operation: 'storage-buckets', environment: 'development', expectedRef: 'ref' }
    const response = await post({ operation: 'storage', options })
    expect(response.status).toBe(200)
    expect(mocks.storage).toHaveBeenCalledWith(expect.objectContaining({ ownerId, projectId, deviceId, verifyIdentity: expect.any(Function) }), options)
    expect(JSON.stringify(mocks.storage.mock.calls)).not.toContain(input.deviceSecret)
    expect(await response.json()).toMatchObject({ projectId, operation: 'storage', data: { items: [] } })
    expect(response.headers.get('Cache-Control')).toBe('no-store')
  })
  it('does not disclose private errors when ownership is missing or the provider fails', async () => {
    mocks.project.mockRejectedValueOnce(new Error('PRIVATE_DATABASE_PASSWORD'))
    const denied = await post({ operation: 'integration-status' })
    expect(denied.status).toBe(409); expect(await denied.text()).not.toContain('PRIVATE')
    expect(mocks.connections).not.toHaveBeenCalled()
    mocks.storage.mockRejectedValue(new Error('PRIVATE_PROVIDER_TOKEN'))
    const failed = await post({ operation: 'storage', options: { operation: 'storage-buckets', environment: 'development', expectedRef: 'ref' } })
    expect(await failed.text()).not.toContain('PRIVATE')
  })
  it('only locates operation receipts with all ownership filters, omitting lease tokens', async () => {
    const eq = vi.fn(() => query)
    const query = { select: vi.fn(() => query), eq, maybeSingle: vi.fn(async () => ({ error: null, data: { id: operationId, capability: 'data.update', environment: 'development', state: 'running', updated_at: '2026-10-05T10:00:00Z', message: 'Working', result: { email: 'private@example.test' }, lease_expires_at: '2020-01-01T00:00:00Z', claim_token: deviceId, input_digest: 'a'.repeat(64) } })) }
    mocks.from.mockReturnValue(query)
    const response = await post({ operation: 'operation-status', id: operationId })
    const body = await response.json()
    expect(body).toMatchObject({ data: { id: operationId, state: 'uncertain', result: null, resultOmitted: true } })
    expect(JSON.stringify(body)).not.toContain('private@example.test')
    expect(eq.mock.calls).toEqual([['id', operationId], ['user_id', ownerId], ['project_id', projectId]])
  })
  it('lists the existing connector lifecycle without an implicit create or invocation', async () => {
    expect((await post({ operation: 'integration-status' })).status).toBe(200)
    expect(mocks.proposals).toHaveBeenCalledOnce(); expect(mocks.sessions).toHaveBeenCalledOnce()
    expect(mocks.proposal).not.toHaveBeenCalled(); expect(mocks.integration).not.toHaveBeenCalled()
    expect(mocks.authorize).toHaveBeenCalledTimes(2)
  })
  it('requires integration read authority and never returns another environment', async () => {
    mocks.authorize.mockRejectedValueOnce(new OperationError('Sem autorização.', 403))
    expect((await post({ operation: 'integration-status' })).status).toBe(403)
    expect(mocks.connections).not.toHaveBeenCalled()
    mocks.connections.mockResolvedValue([{ id: 'dev', environment: 'development' }, { id: 'prod', environment: 'production' }])
    mocks.sessions.mockResolvedValue([{ connectionId: 'dev' }, { connectionId: 'prod' }])
    mocks.proposals.mockResolvedValue([{ input: { environment: 'development' } }, { input: { environment: 'production' } }])
    const response = await post({ operation: 'integration-status' })
    expect(await response.json()).toMatchObject({ data: { connections: [{ id: 'dev', environment: 'development' }], sessions: [{ connectionId: 'dev' }], proposals: [{ input: { environment: 'development' } }] } })
  })
  it('withholds integration results if policy changes during inspection', async () => {
    mocks.authorize.mockResolvedValueOnce({ policyId: operationId, revision: 'before' }).mockResolvedValueOnce({ policyId: operationId, revision: 'after' })
    const response = await post({ operation: 'integration-status' })
    expect(response.status).toBe(409)
    expect(await response.json()).not.toHaveProperty('data')
  })
})
