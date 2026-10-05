import type { SupabaseClient } from '@supabase/supabase-js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ project: vi.fn(), credentials: vi.fn(), environment: vi.fn(), policy: vi.fn(), readPolicy: vi.fn(), query: vi.fn(), factory: vi.fn() }))
vi.mock('../projects/repository', () => ({ getProject: mocks.project, getSupabaseCredentials: mocks.credentials }))
vi.mock('../database-environment/store', () => ({ readEnvironment: mocks.environment }))
vi.mock('../backend-operations/server', () => ({ authorizeProjectOperation: mocks.policy, readOperationPolicy: mocks.readPolicy }))
vi.mock('../database-inspection/provider', async original => ({ ...await original<typeof import('../database-inspection/provider')>(), supabaseInspectionProvider: mocks.factory }))
import { readAuthorizedUsage, saveAuthorizedUsageLimits } from './server'
const ownerId = '11111111-1111-4111-8111-111111111111', projectId = '22222222-2222-4222-8222-222222222222'
const input = { projectId, expectedRef: 'owned-ref', environment: 'development' as const }
const project = { supabase_project_ref: input.expectedRef, supabase_account_id: 'account' }
type RowResult = { data: unknown; error: object | null; count?: number | null }
function fixture() {
  const reads: Array<{ table: string; filters: Array<[string, unknown]>; mode: string; values?: unknown }> = []
  const failures = new Set<string>()
  const from = (table: string) => {
    const call: typeof reads[number] = { table, filters: [], mode: 'read' }; reads.push(call)
    const result = (): RowResult => {
      if (failures.has(table)) return { data: null, error: {} }
      if (table === 'project_backend_operations') return { data: null, error: null, count: 2 }
      if (table === 'project_usage_alert_settings' && call.mode === 'read') return { data: { limits: [{ metric: 'Conexões atuais', maximum: 10 }] }, error: null }
      if (table === 'project_usage_snapshots' && call.mode === 'read') return { data: [{ observed_at: '2026-10-05T00:00:00Z', metrics: [{ name: 'Conexões atuais', value: null, available: false }] }], error: null }
      return { data: null, error: null }
    }
    const query = {
      select: () => query, eq: (field: string, value: unknown) => { call.filters.push([field, value]); return query }, gte: () => query, lt: () => query, order: () => query, limit: () => query,
      maybeSingle: () => Promise.resolve(result()), upsert: (values: unknown) => { call.values = values; call.mode = 'upsert'; return query }, delete: () => { call.mode = 'delete'; return query },
      then: <T>(fulfilled: (value: RowResult) => T) => Promise.resolve(result()).then(fulfilled),
    }
    return query
  }
  const authority = { client: { from } as unknown as SupabaseClient, ownerId, projectId, deviceId: projectId, verifyIdentity: vi.fn(async () => ownerId) }
  return { authority, reads, failures }
}
beforeEach(() => {
  vi.resetAllMocks()
  mocks.project.mockResolvedValue(project); mocks.environment.mockResolvedValue({ project_ref: input.expectedRef, environment: 'development', source: 'supremo_provisioned' })
  mocks.credentials.mockResolvedValue({ projectRef: input.expectedRef, token: 'private-management-token' })
  mocks.policy.mockResolvedValue({ policyId: 'policy', revision: 'revision' }); mocks.readPolicy.mockResolvedValue({ enabled: true, maxOperationsPerHour: 30 })
  mocks.query.mockResolvedValue([{ database_bytes: 200, connections: 10, users: 0, tables: 1, approximate_rows: 0, objects: 0, storage_bytes: 0 }])
  mocks.factory.mockImplementation((resolve: () => Promise<unknown>) => ({ query: async (sql: string) => { await resolve(); return mocks.query(sql) }, logs: async () => [] }))
})
describe('shared usage service', () => {
  it('collects numeric metrics only, scopes stored history, reports engine quota separately and evaluates thresholds', async () => {
    const { authority, reads } = fixture(), result = await readAuthorizedUsage(authority, input)
    expect(result).toMatchObject({ providerQuotasAvailable: false, historyAvailable: true, engineQuota: { maximum: 30 }, alerts: [{ metric: 'Conexões atuais', state: 'limit_reached', value: 10 }] })
    expect(result.current.metrics.find(metric => metric.name === 'Operações do motor na última hora')?.value).toBe(2)
    expect(result.history[0]?.metrics[0]?.value).toBeNull()
    expect(mocks.policy).toHaveBeenCalledWith(expect.objectContaining({ deviceId: projectId, environment: 'development' }), 'data.read')
    expect(reads.find(read => read.mode === 'upsert')?.values).toMatchObject({ user_id: ownerId, project_id: projectId, target_ref: input.expectedRef, environment: 'development' })
    for (const read of reads.filter(read => read.mode === 'read' && read.table !== 'project_backend_operations')) expect(read.filters).toEqual(expect.arrayContaining([['user_id', ownerId], ['project_id', projectId], ['target_ref', input.expectedRef], ['environment', 'development']]))
    expect(JSON.stringify(result)).not.toContain('private-management-token')
  })
  it('preserves unavailable metrics and refuses to pretend that missing storage or quota data is zero', async () => {
    const { authority, failures } = fixture(); failures.add('project_usage_snapshots'); failures.add('project_usage_alert_settings'); failures.add('project_backend_operations')
    mocks.query.mockRejectedValue(new Error('upstream private failure')); mocks.readPolicy.mockResolvedValue(null)
    const result = await readAuthorizedUsage(authority, input)
    expect(result.historyAvailable).toBe(false); expect(result.history).toEqual([]); expect(result.limits).toEqual([]); expect(result.engineQuota.maximum).toBeNull()
    expect(result.current.metrics.every(metric => metric.value === null && !metric.available)).toBe(true)
  })
  it('blocks identity, project, environment, account and policy changes before returning or persisting an observation', async () => {
    const { authority, reads } = fixture()
    await expect(readAuthorizedUsage(authority, { ...input, projectId: ownerId })).rejects.toThrow('Projeto')
    await expect(readAuthorizedUsage(authority, { ...input, environment: 'production' })).rejects.toThrow('ambiente')
    authority.verifyIdentity.mockResolvedValueOnce(projectId)
    await expect(readAuthorizedUsage(authority, input)).rejects.toThrow('sessão')
    mocks.query.mockImplementationOnce(async () => { mocks.project.mockResolvedValue({ ...project, supabase_account_id: 'replacement' }); return [] })
    await expect(readAuthorizedUsage(authority, input)).rejects.toThrow('conta')
    mocks.project.mockResolvedValue(project)
    mocks.query.mockImplementationOnce(async () => { mocks.policy.mockResolvedValue({ policyId: 'policy', revision: 'changed' }); return [] })
    await expect(readAuthorizedUsage(authority, input)).rejects.toThrow('autorização mudou')
    expect(reads.some(read => read.mode === 'upsert')).toBe(false)
  })
  it('requires a separately verified owner for settings and cannot broaden agent capability', async () => {
    const { authority, reads, failures } = fixture(), verifyOwnerSession = vi.fn(async () => projectId)
    const settings = { ...input, limits: [{ metric: 'Conexões atuais', maximum: 20 }] }
    await expect(saveAuthorizedUsageLimits({ ...authority, verifyOwnerSession }, settings)).rejects.toThrow('Apenas o dono')
    expect(reads).toHaveLength(0)
    verifyOwnerSession.mockResolvedValue(ownerId)
    await saveAuthorizedUsageLimits({ ...authority, verifyOwnerSession }, settings)
    expect(mocks.policy).not.toHaveBeenCalled()
    expect(reads[0]?.values).toMatchObject({ limits: settings.limits, user_id: ownerId, project_id: projectId })
    failures.add('project_usage_alert_settings')
    await expect(saveAuthorizedUsageLimits({ ...authority, verifyOwnerSession }, settings)).rejects.toThrow('não foram salvos')
    verifyOwnerSession.mockResolvedValueOnce(ownerId).mockResolvedValueOnce(projectId)
    await expect(saveAuthorizedUsageLimits({ ...authority, verifyOwnerSession }, settings)).rejects.toThrow('sessão mudou')
  })
})
