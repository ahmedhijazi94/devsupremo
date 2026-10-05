import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
const mocks = vi.hoisted(() => ({ environment: vi.fn(), describe: vi.fn() }))
vi.mock('../database-environment/store', () => ({ readEnvironment: mocks.environment }))
vi.mock('../database-environment/policy', () => ({ describeEnvironment: mocks.describe }))
import { authorizeProjectOperation, readOperationPolicy } from './server'
import { backendOperationStore, operationReceipt } from './store'

const ownerId = '11111111-1111-4111-8111-111111111111', projectId = '22222222-2222-4222-8222-222222222222', id = '33333333-3333-4333-8333-333333333333', revision = '44444444-4444-4444-8444-444444444444'
const policy = { id, user_id: ownerId, project_id: projectId, environment: 'development', revision, enabled: true, capabilities: ['data.update'], max_rows: 25, max_operations_per_hour: 60, resources: ['public.notes'], device_ids: [] }
const receipt = { id, capability: 'data.update', environment: 'development', state: 'queued', updated_at: '2026-10-05T10:00:00Z', lease_expires_at: '2099-10-05T10:00:00Z', message: 'Waiting', result: null, claim_token: revision, input_digest: 'a'.repeat(64) }
function clientFixture() {
  const projects = { data: { id: projectId, supabase_project_ref: 'ref' } as unknown, error: null as unknown }
  const policies = { data: policy as unknown, error: null as unknown }
  const operation = { data: receipt as unknown, error: null as unknown }
  const filters: Array<[string, string, unknown]> = []
  const rpc = vi.fn<(name: string, input: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>>(async () => ({ data: [receipt], error: null }))
  const from = vi.fn((table: string) => {
    const result = table === 'projects' ? projects : table === 'project_automation_policies' ? policies : operation
    const query = { select: vi.fn(() => query), update: vi.fn(() => query), eq: vi.fn((name: string, value: unknown) => { filters.push([table, name, value]); return query }),
      in: vi.fn(() => query), gt: vi.fn(() => query), maybeSingle: vi.fn(async () => result) }
    return query
  })
  return { client: { from, rpc } as unknown as SupabaseClient, projects, policies, operation, filters, rpc, from }
}
beforeEach(() => { vi.clearAllMocks(); mocks.environment.mockResolvedValue({}); mocks.describe.mockReturnValue({ environment: 'development', projectRef: 'ref' }) })
describe('administrative authority and receipt persistence', () => {
  it('loads only owner/project/environment policy and preserves its validation', async () => {
    const f = clientFixture()
    expect(await readOperationPolicy(f.client, ownerId, projectId, 'development')).toMatchObject({ id, revision })
    expect(f.filters).toEqual(expect.arrayContaining([['project_automation_policies', 'user_id', ownerId], ['project_automation_policies', 'project_id', projectId], ['project_automation_policies', 'environment', 'development']]))
    f.policies.data = { ...policy, capabilities: ['data.update', 'data.update'] }
    await expect(readOperationPolicy(f.client, ownerId, projectId, 'development')).rejects.toThrow('Política inválida')
    f.policies.data = null
    expect(await readOperationPolicy(f.client, ownerId, projectId, 'development')).toBeNull()
    f.policies.error = new Error('private backend diagnostic')
    await expect(readOperationPolicy(f.client, ownerId, projectId, 'development')).rejects.toThrow('migration 028')
  })
  it('rechecks identity after loading policy and refuses changed owner/target/limits', async () => {
    const f = clientFixture(), identity = vi.fn(async () => ownerId)
    const authority = { client: f.client, ownerId, projectId, environment: 'development' as const, verifyIdentity: identity }
    expect(await authorizeProjectOperation(authority, 'data.update', { rows: 1, resource: 'public.notes' })).toEqual({ policyId: id, revision })
    expect(f.filters).toContainEqual(['projects', 'user_id', ownerId])
    identity.mockResolvedValueOnce(ownerId).mockResolvedValueOnce('other')
    await expect(authorizeProjectOperation(authority, 'data.update')).rejects.toThrow('Sessão ou dispositivo mudou')
    identity.mockResolvedValue('other')
    await expect(authorizeProjectOperation(authority, 'data.update')).rejects.toThrow('não autorizado')
    identity.mockResolvedValue(ownerId); f.projects.data = null
    await expect(authorizeProjectOperation(authority, 'data.update')).rejects.toThrow('Projeto não autorizado')
    f.projects.data = { id: projectId, supabase_project_ref: 'ref' }; mocks.describe.mockReturnValue({ environment: 'production' })
    await expect(authorizeProjectOperation(authority, 'data.update')).rejects.toThrow('ambiente conectado mudou')
  })
  it('marks expired work uncertain and does not return internal claim tokens', () => {
    expect(operationReceipt({ ...receipt, lease_expires_at: '2020-01-01T00:00:00Z' })).toMatchObject({ state: 'uncertain' })
    const saved = operationReceipt({ ...receipt, state: 'succeeded', result: { verified: true } })
    expect(saved).toMatchObject({ state: 'succeeded', result: { verified: true } })
    expect(saved).not.toHaveProperty('claim_token')
    expect(() => operationReceipt({ ...receipt, capability: 'arbitrary' })).toThrow()
  })
  it('uses shared RPC admission without persisting request values and will not acquire another claimant', async () => {
    const f = clientFixture(), store = backendOperationStore(f.client, { ownerId, projectId, id, capability: 'data.update', input: { privateValue: 'not-in-rpc' } })
    expect(await store.claim({ policyId: id, revision })).toMatchObject({ acquired: false })
    expect(JSON.stringify(f.rpc.mock.calls)).not.toContain('not-in-rpc')
    expect(f.rpc.mock.calls[0]?.[1]).toMatchObject({ p_owner: ownerId, p_project: projectId, p_revision: revision, p_digest: expect.stringMatching(/^[a-f0-9]{64}$/) })
    f.rpc.mockImplementation(async (_name, input) => ({ data: [{ ...receipt, claim_token: input.p_token }], error: null }))
    expect(await store.claim({ policyId: id, revision })).toMatchObject({ acquired: true })
    f.rpc.mockResolvedValue({ data: [], error: null })
    await expect(store.claim({ policyId: id, revision })).rejects.toThrow('não pôde ser reservada')
  })
  it('requires the same project, owner, claim and live lease to finish a receipt', async () => {
    const f = clientFixture(), store = backendOperationStore(f.client, { ownerId, projectId, id, capability: 'data.update', input: {} })
    f.operation.data = { ...receipt, state: 'succeeded' }
    expect(await store.update(id, revision, 'succeeded', 'Confirmed', { verified: true })).toHaveProperty('state', 'succeeded')
    expect(f.filters).toEqual(expect.arrayContaining([['project_backend_operations', 'id', id], ['project_backend_operations', 'user_id', ownerId], ['project_backend_operations', 'project_id', projectId], ['project_backend_operations', 'claim_token', revision]]))
    f.operation.data = null
    await expect(store.update(id, revision, 'failed', 'Failed')).rejects.toThrow('não repita')
  })
})
