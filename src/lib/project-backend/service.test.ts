import { describe, expect, it, vi } from 'vitest'
import { backendInputSchema, type BackendInput } from './contract'
import { runBackend, type BackendPorts } from './service'
import type { FunctionResponse } from '../edge-functions/contract'

const projectId = '11111111-1111-4111-8111-111111111111'
const target = { projectRef: 'projectref', environment: 'development' as const }
const base = { projectId, operation: 'tables' as const }
const functionResult = (operation: 'functions-list' | 'functions-status', slug?: string): FunctionResponse => ({
  projectId, ...target, observedAt: new Date().toISOString(), execution: 'server_api', providerDashboardRequired: false, valuesReceived: false, readOnly: true,
  ...(operation === 'functions-list' ? { operation, data: { functions: [{ slug: 'second', version: 1, status: 'ACTIVE' as const, verifyJwt: true }, { slug: 'first', version: 2, status: 'ACTIVE' as const, verifyJwt: false }] } }
    : { operation, data: { function: slug === 'missing' ? null : { slug: slug!, version: 2, status: 'ACTIVE' as const, verifyJwt: true } } }),
})
function ports(): BackendPorts {
  return { inspection: { query: vi.fn(async () => []), logs: vi.fn(async () => []) },
    functions: vi.fn(async (op, slug) => functionResult(op, slug)),
    jobs: vi.fn(async () => ({ available: true, rows: [], hasMore: false, nextOffset: null })),
    users: vi.fn(async () => ({ users: [], mayHaveMore: false })) }
}
describe('project backend console', () => {
  it.each([
    { ...base, ownerId: 'attacker' }, { ...base, operation: 'rows', table: 'auth.users' },
    { ...base, operation: 'rows', table: 'x";DELETE' }, { ...base, sql: 'SELECT 1' },
    { ...base, limit: 101 }, { ...base, operation: 'job-set-active', jobId: 'daily', enabled: false },
    { ...base, operation: 'job-set-active', jobId: 'daily', enabled: false, expectedRef: 'ref', environment: 'unknown' },
  ])('rejects forged or ambiguous input %#', value => expect(backendInputSchema.safeParse(value).success).toBe(false))
  it('reads only public rows with read-only SQL and pagination', async () => {
    const p = ports(); vi.mocked(p.inspection.query).mockResolvedValue([{ id: 1 }, { id: 2 }])
    const result = await runBackend(p, target, { ...base, operation: 'rows', table: 'expenses', limit: 1, offset: 3 })
    expect(p.inspection.query).toHaveBeenCalledWith(expect.stringContaining('public."expenses"'))
    expect(result).toMatchObject({ items: [{ id: 1 }], hasMore: true, nextOffset: 4 })
  })
  it.each(['DELETE FROM public.expenses', 'SELECT * FROM auth.users', "SELECT pg_read_file('/etc/passwd')"])('rejects unsafe editor SQL before provider access', async sql => {
    const p = ports()
    await expect(runBackend(p, target, { ...base, operation: 'query', sql })).rejects.toThrow('recusada')
    expect(p.inspection.query).not.toHaveBeenCalled()
  })
  it('redacts protected fields and accepts a bounded public SELECT', async () => {
    const p = ports(); vi.mocked(p.inspection.query).mockResolvedValue([{ description: 'value', access_token: 'private' }])
    const result = await runBackend(p, target, { ...base, operation: 'query', sql: 'SELECT description FROM public.expenses' })
    expect(result.items).toEqual([{ description: 'value', access_token: '[REDACTED]' }])
  })
  it('catalog and logs remain separate from arbitrary SQL', async () => {
    const p = ports()
    await runBackend(p, target, base)
    expect(p.inspection.query).toHaveBeenCalledWith(expect.stringContaining("n.nspname='public'"))
    await runBackend(p, target, { ...base, operation: 'logs', source: 'auth', level: 'error', minutes: 10 })
    expect(p.inspection.logs).toHaveBeenCalledWith(expect.any(URLSearchParams))
  })
  it('lists sorted functions and handles absent function', async () => {
    const p = ports()
    expect(await runBackend(p, target, { ...base, operation: 'functions', limit: 1 })).toMatchObject({ total: 2, hasMore: true, items: [{ slug: 'first' }] })
    expect(await runBackend(p, target, { ...base, operation: 'function-status', slug: 'missing' })).toMatchObject({ items: [] })
    expect(await runBackend(p, target, { ...base, operation: 'function-status', slug: 'first' })).toMatchObject({ items: [{ slug: 'first' }] })
  })
  it('reads user metadata and buckets using fixed ports', async () => {
    const p = ports(); vi.mocked(p.users).mockResolvedValue({ users: [{ email: 'user@example.test' }], mayHaveMore: true })
    expect(await runBackend(p, target, { ...base, operation: 'users', limit: 1, offset: 1 })).toMatchObject({ hasMore: true, nextOffset: 2 })
    vi.mocked(p.inspection.query).mockResolvedValue([{ id: 'assets' }, { id: 'uploads' }])
    expect(await runBackend(p, target, { ...base, operation: 'storage', limit: 1 })).toMatchObject({ hasMore: true, nextOffset: 1 })
    expect(p.inspection.query).toHaveBeenCalledWith(expect.stringContaining('FROM storage.buckets'))
  })
  it('keeps unavailable metrics distinct from measured zero', async () => {
    const p = ports()
    vi.mocked(p.inspection.query).mockResolvedValueOnce([{ database_bytes: '0', connections: 3 }]).mockRejectedValueOnce(new Error('secret-provider-error')).mockResolvedValueOnce([{ objects: '2', storage_bytes: '100' }])
    const result = await runBackend(p, target, { ...base, operation: 'usage' })
    expect(result.metrics).toContainEqual({ name: 'Tamanho do banco', value: 0, unit: 'bytes', available: true })
    expect(result.metrics).toContainEqual({ name: 'Usuários cadastrados', value: null, available: false })
    expect(JSON.stringify(result)).not.toContain('secret-provider-error')
  })
  it('handles malformed or empty metrics without claiming zero', async () => {
    const p = ports(); vi.mocked(p.inspection.query).mockResolvedValue([{ database_bytes: 'nan', connections: -1 }])
    const result = await runBackend(p, target, { ...base, operation: 'usage' })
    expect(result.metrics?.every(metric => metric.value === null)).toBe(true)
  })
  it('normalizes jobs, empty registries and execution history', async () => {
    const p = ports()
    vi.mocked(p.jobs).mockResolvedValueOnce({ available: true, rows: [{ job_id: 'daily', table_name: 'expenses' }] })
      .mockResolvedValueOnce({ available: false, rows: [] }).mockResolvedValueOnce({ available: true, rows: [{ job_id: 'daily', http_status: 'http_failed' }] })
    expect(await runBackend(p, target, { ...base, operation: 'jobs' })).toMatchObject({ items: [{ jobId: 'daily', target: 'expenses', type: 'update' }] })
    expect(await runBackend(p, target, { ...base, operation: 'jobs' })).toHaveProperty('message')
    expect(await runBackend(p, target, { ...base, operation: 'job-history', jobId: 'daily' })).toMatchObject({ items: [{ jobId: 'daily', http_status: 'http_failed' }] })
  })
  it.each([true, false])('changes job state only after target match and confirmed provider receipt (%s)', async enabled => {
    const p = ports(), input: BackendInput = { ...base, operation: 'job-set-active', enabled, jobId: 'daily', expectedRef: target.projectRef, environment: target.environment }
    await expect(runBackend(p, { ...target, projectRef: 'other' }, input)).rejects.toThrow('mudou')
    expect(p.jobs).not.toHaveBeenCalled()
    vi.mocked(p.jobs).mockResolvedValue({ available: true, applied: true, jobId: 'daily' })
    expect(await runBackend(p, target, input)).toHaveProperty('message', enabled ? 'Agendamento ativado.' : 'Agendamento pausado.')
    expect(p.jobs).toHaveBeenCalledWith(enabled ? 'cron-resume' : 'cron-pause', expect.objectContaining({ jobId: 'daily' }))
    vi.mocked(p.jobs).mockResolvedValue({ available: true, applied: true, jobId: 'other' })
    await expect(runBackend(p, target, input)).rejects.toThrow()
  })
})
