import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { POST } from './route'
import { authenticateDeviceSecret } from '@/lib/checkpoint/devices'
import { getProject, getSupabaseCredentials } from '@/lib/projects/repository'
import { readEnvironment } from '@/lib/database-environment/store'

vi.mock('@/lib/supabase/admin', () => ({ createServiceClient: () => ({}) }))
vi.mock('@/lib/checkpoint/store', () => ({ supabaseCheckpointDeviceStore: () => ({}) }))
vi.mock('@/lib/checkpoint/devices', () => ({ authenticateDeviceSecret: vi.fn() }))
vi.mock('@/lib/projects/repository', () => ({ getProject: vi.fn(), getSupabaseCredentials: vi.fn() }))
vi.mock('@/lib/database-environment/store', () => ({ readEnvironment: vi.fn() }))

const identity = { deviceSecret: 'device-fixture', projectId: '00000000-0000-4000-8000-000000000001' }
const project = { id: identity.projectId, user_id: 'owner', supabase_project_ref: 'dev-ref', supabase_account_id: 'owned-account' } as Awaited<ReturnType<typeof getProject>>
const device = { id: 'device', ownerUserId: 'owner', revokedAt: null, label: null }
const environment = { project_ref: 'dev-ref', environment: 'development', source: 'supremo_provisioned' } as const
const body = { ...identity, operation: 'cron-list', environment: 'development', expectedRef: 'dev-ref' }
const request = (extra: Record<string, unknown> = {}) => new NextRequest('https://supremo.test/api/database', { method: 'POST', body: JSON.stringify({ ...body, ...extra }) })
const job = { id: 'expire-tickets', schedule: '*/5 * * * *', timezone: 'UTC', action: { type: 'update', table: 'tickets', set: { status: 'overdue' }, where: [{ column: 'status', op: 'eq', value: 'open' }] } }
const table = { oid: 1234, name: 'tickets', kind: 'r', rls: true, partition: false, inherits: false,
  columns: ['id', 'status'].map((name) => ({ name, type: name === 'id' ? 'uuid' : 'text', schema: 'pg_catalog', kind: 'b', generated: '', collation_schema: null })),
  primary_key: ['id'], foreign_key_columns: [], checks: [], rules: [], indexes: [], dependencies: [], policies: [], triggers: [], fingerprint: 'a'.repeat(64) }
beforeEach(() => {
  vi.mocked(authenticateDeviceSecret).mockResolvedValue({ ok: true, device })
  vi.mocked(getProject).mockResolvedValue(project)
  vi.mocked(readEnvironment).mockResolvedValue(environment)
  vi.mocked(getSupabaseCredentials).mockResolvedValue({ projectRef: 'dev-ref', token: 'provider-private-fixture' })
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const sql = String(JSON.parse(String(init?.body)).query)
    if (sql.includes('AS installed')) return Response.json([{ installed: true, registry: true, timezone: 'UTC' }])
    if (sql.includes('AS applied')) return Response.json([{ applied: true, ...(sql.includes('AS job_count') ? { job_count: 1 } : {}) }])
    if (sql.includes('AS fingerprint FROM metadata')) return Response.json([table])
    if (sql.includes('d.runid')) return Response.json([{ job_id: job.id, runid: 1, status: 'failed', start_time: '2026-09-08', end_time: null, diagnostic: 'Generic failure', command: 'SECRET SQL', return_message: 'private failing row' }])
    return Response.json([{ job_id: job.id, table_name: 'tickets', active: true, schedule: job.schedule, timezone: 'UTC', created_at: '2026-09-08', updated_at: '2026-09-08', synchronized: true, command: 'SECRET SQL' }])
  }))
})
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals() })

describe('typed jobs device route', () => {
  it.each(['development', 'production', 'unknown'] as const)('reads owner jobs in %s without issuing mutations', async (env) => {
    vi.mocked(readEnvironment).mockResolvedValue(env === 'unknown' ? null : { ...environment, environment: env })
    const response = await POST(request({ environment: env }))
    expect(response.status).toBe(200)
    const result = await response.json()
    expect(result).toMatchObject({ projectId: identity.projectId, projectRef: 'dev-ref', environment: env, readOnly: true, untrustedData: true, data: { available: true, rows: [{ job_id: job.id }] } })
    expect(JSON.stringify(result)).not.toContain('SECRET')
    expect(JSON.stringify(result)).not.toContain('private-fixture')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(getProject).toHaveBeenCalledWith('owner', identity.projectId)
    expect(vi.mocked(fetch).mock.calls.every(([, init]) => String(init?.body).includes('BEGIN READ ONLY;'))).toBe(true)
    expect(authenticateDeviceSecret).toHaveBeenCalledTimes(5)
  })
  it('returns paginated history without raw SQL, failing rows or other provider fields', async () => {
    const response = await POST(request({ operation: 'cron-history', limit: 1, offset: 2, jobId: job.id }))
    expect(response.status).toBe(200)
    const result = await response.json()
    expect(result.data.rows[0]).toEqual({ job_id: job.id, runid: 1, status: 'failed', start_time: '2026-09-08', end_time: null, diagnostic: 'Generic failure' })
    expect(String(vi.mocked(fetch).mock.calls[1]![1]!.body)).toContain('LIMIT 2 OFFSET 2')
  })
  it.each(['cron-apply', 'cron-pause', 'cron-resume', 'cron-remove'])('%s dispatches only generated transactional declarations in verified development', async (operation) => {
    const response = await POST(request({ operation, ...(operation === 'cron-apply' ? { manifest: { version: 1, jobs: [job] } } : { jobId: job.id }) }))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ readOnly: false, data: { applied: true } })
    const last = vi.mocked(fetch).mock.calls.at(-1)!
    expect(String(last[1]!.body)).toContain('BEGIN;')
    expect(String(last[1]!.body)).toContain(identity.projectId)
    expect(last[1]).toMatchObject({ redirect: 'error', cache: 'no-store' })
  })
  it.each(['production', 'unknown'] as const)('refuses automatic jobs writes in %s before accessing credentials', async (env) => {
    vi.mocked(readEnvironment).mockResolvedValue(env === 'unknown' ? null : { ...environment, environment: env })
    for (const operation of ['cron-apply', 'cron-pause', 'cron-resume', 'cron-remove']) {
      expect((await POST(request({ operation, environment: env, ...(operation === 'cron-apply' ? { manifest: { version: 1, jobs: [job] } } : { jobId: job.id }) }))).status).toBe(409)
    }
    expect(fetch).not.toHaveBeenCalled()
    expect(getSupabaseCredentials).not.toHaveBeenCalled()
  })
  it('rejects revoked device, other owner and forged expected environment/ref', async () => {
    vi.mocked(authenticateDeviceSecret).mockResolvedValueOnce({ ok: false, reason: 'revoked' })
    expect((await POST(request())).status).toBe(401)
    vi.mocked(getProject).mockRejectedValueOnce(new Error('private-owner-database-detail'))
    const forbidden = await POST(request())
    expect(forbidden.status).toBe(409)
    expect(JSON.stringify(await forbidden.json())).not.toContain('private-owner')
    expect((await POST(request({ environment: 'production' }))).status).toBe(409)
    expect((await POST(request({ expectedRef: 'other-ref' }))).status).toBe(409)
    expect(fetch).not.toHaveBeenCalled()
  })
  it('rechecks revocation after credential resolution and never follows stale account/ref/environment', async () => {
    vi.mocked(authenticateDeviceSecret).mockResolvedValueOnce({ ok: true, device }).mockResolvedValueOnce({ ok: true, device }).mockResolvedValueOnce({ ok: false, reason: 'revoked' })
    expect((await POST(request())).status).toBe(401)
    vi.mocked(getSupabaseCredentials).mockResolvedValueOnce({ projectRef: 'other-ref', token: 'fixture' })
    expect((await POST(request())).status).toBe(409)
    vi.mocked(getProject).mockResolvedValueOnce(project).mockResolvedValueOnce(project).mockResolvedValueOnce({ ...project, supabase_account_id: 'changed-account' })
    expect((await POST(request())).status).toBe(409)
    vi.mocked(readEnvironment).mockResolvedValueOnce(environment).mockResolvedValueOnce(environment).mockResolvedValueOnce({ ...environment, environment: 'production' })
    expect((await POST(request())).status).toBe(409)
    expect(fetch).not.toHaveBeenCalled()
  })
  it('rechecks development after catalog lookup before any SQL write', async () => {
    vi.mocked(fetch).mockImplementation(async (_url, init) => {
      const sql = String(JSON.parse(String(init?.body)).query)
      if (sql.includes('AS installed')) return Response.json([{ installed: true, registry: true, timezone: 'UTC' }])
      vi.mocked(readEnvironment).mockResolvedValue({ ...environment, environment: 'production' })
      return Response.json([table])
    })
    const response = await POST(request({ operation: 'cron-apply', manifest: { version: 1, jobs: [job] } }))
    expect(response.status).toBe(409)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(vi.mocked(fetch).mock.calls.every(([, init]) => String(init?.body).includes('BEGIN READ ONLY;'))).toBe(true)
  })
  it('rejects raw SQL, client credentials, malformed manifests and missing mutation IDs at the route', async () => {
    for (const extra of [{ sql: 'SELECT secret' }, { token: 'forged' }, { operation: 'cron-pause' }, { operation: 'cron-apply', manifest: { version: 1, jobs: [{ ...job, function: 'public.arbitrary_sql' }] } }]) {
      expect((await POST(request(extra))).status).toBe(400)
    }
    expect(fetch).not.toHaveBeenCalled()
    expect(getProject).not.toHaveBeenCalled()
  })
  it('reports provider refusal without echoing SQL, values or tokens', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('provider-private-fixture SECRET SQL', { status: 403 }))
    const response = await POST(request())
    expect(response.status).toBe(502)
    const result = await response.json()
    expect(result.error).toContain('HTTP 403')
    expect(JSON.stringify(result)).not.toMatch(/private-fixture|SECRET SQL/)
  })
})
