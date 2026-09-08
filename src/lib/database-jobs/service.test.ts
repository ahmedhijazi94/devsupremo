import { describe, expect, it, vi } from 'vitest'
import { requireJobTarget, runJobs } from './service'
import { jobsRequestSchema } from './policy'
import { cronCapabilitySql } from './sql'
import type { JobsProvider } from './provider'

const projectId = '00000000-0000-4000-8000-000000000001'
const job = { id: 'expire-tickets', schedule: '*/5 * * * *', timezone: 'UTC', action: { type: 'update', table: 'tickets', set: { status: 'overdue' }, where: [{ column: 'status', op: 'eq', value: 'open' }], limit: 100 } }
const options = (extra: Record<string, unknown> = {}) => jobsRequestSchema.parse({ projectId, deviceSecret: 'device-fixture', operation: 'cron-list', expectedRef: 'dev-ref', environment: 'development', ...extra })
const capability = { installed: true, registry: true, timezone: 'UTC' }
const table = {
  oid: 1234, name: 'tickets', kind: 'r', rls: true, partition: false, inherits: false,
  columns: ['id', 'status'].map((name) => ({ name, type: name === 'id' ? 'uuid' : 'text', schema: 'pg_catalog', kind: 'b', generated: '', collation_schema: null })),
  primary_key: ['id'], foreign_key_columns: [], checks: [], rules: [], indexes: [], dependencies: [], policies: [], triggers: [], fingerprint: 'a'.repeat(64),
}
const listed = { job_id: job.id, table_name: 'tickets', active: true, schedule: job.schedule, timezone: 'UTC', created_at: '2026-09-08T00:00:00Z', updated_at: '2026-09-08T00:00:00Z', synchronized: true }
const history = { job_id: job.id, runid: 12, status: 'succeeded', start_time: listed.created_at, end_time: listed.created_at, diagnostic: null }
const provider = (...results: unknown[][]) => {
  const query = vi.fn<JobsProvider['query']>()
  for (const result of results) query.mockResolvedValueOnce(result)
  return { query }
}

describe('jobs authority and confirmed orchestration', () => {
  it.each(['development', 'production', 'unknown'] as const)('reads %s only when authoritative ref/environment match', (environment) => {
    const record = environment === 'unknown' ? null : { project_ref: 'dev-ref', environment, source: 'supremo_provisioned' }
    expect(requireJobTarget(record, 'dev-ref', options({ environment })).environment).toBe(environment)
    expect(() => requireJobTarget(record, 'other-ref', options({ environment }))).toThrow('Vínculo')
    expect(() => requireJobTarget(record, 'dev-ref', options({ environment: environment === 'development' ? 'production' : 'development' }))).toThrow('Vínculo')
  })
  it.each(['production', 'unknown'] as const)('denies every mutation in %s', (environment) => {
    const record = environment === 'unknown' ? null : { project_ref: 'dev-ref', environment, source: 'supremo_provisioned' }
    for (const operation of ['cron-apply', 'cron-pause', 'cron-resume', 'cron-remove'] as const) {
      const request = options({ operation, environment, ...(operation === 'cron-apply' ? { manifest: { version: 1, jobs: [job] } } : { jobId: job.id }) })
      expect(() => requireJobTarget(record, 'dev-ref', request)).toThrow('development')
    }
  })
  it.each(['cron-list', 'cron-history'])('%s reports unavailable without installing anything', async (operation) => {
    const port = provider([{ ...capability, registry: false }])
    expect(await runJobs(port, options({ operation }))).toMatchObject({ available: false, hasMore: false, rows: [] })
    expect(port.query).toHaveBeenCalledExactlyOnceWith(cronCapabilitySql, { readOnly: true })
  })
  it.each(['cron-list', 'cron-history'])('%s paginates exact own-scope records without leaking provider fields', async (operation) => {
    const row = operation === 'cron-list' ? listed : history
    const port = provider([capability], [row, { ...row, command: 'secret SQL', return_message: 'secret failing row' }])
    const result = await runJobs(port, options({ operation, limit: 1, offset: 3, jobId: job.id }))
    expect(result).toMatchObject({ available: true, rows: [row], rowCount: 1, hasMore: true, nextOffset: 4 })
    expect(JSON.stringify(result)).not.toContain('secret')
    expect(port.query).toHaveBeenLastCalledWith(expect.stringContaining('LIMIT 2 OFFSET 3'), { readOnly: true })
    expect(port.query.mock.calls[1]![0]).toContain(projectId)
    expect(port.query.mock.calls[1]![0]).toContain(job.id)
  })
  it('rejects malformed catalog or excessive results; non-UTC reads remain honest and finite', async () => {
    await expect(runJobs(provider([]), options())).rejects.toThrow('não foi confirmada')
    await expect(runJobs(provider([capability], [{ ...listed, active: 'yes' }]), options())).rejects.toThrow('não foi confirmada')
    await expect(runJobs(provider([capability], [listed, listed, listed]), options({ limit: 1 }))).rejects.toThrow('não foi confirmada')
    expect(await runJobs(provider([{ ...capability, timezone: 'Europe/Berlin' }], [listed, listed]), options({ limit: 1, offset: 10000 }))).toMatchObject({ hasMore: true, nextOffset: null, scheduleAvailable: false })
  })
  it('validates all business tables before any write, bootstraps only if missing, then confirms exact count', async () => {
    const port = provider([{ ...capability, installed: false, registry: false }], [table], [{ ready: true }], [capability], [{ applied: true, job_count: 1 }])
    expect(await runJobs(port, options({ operation: 'cron-apply', manifest: { version: 1, jobs: [job] } }))).toMatchObject({ applied: true, job_count: 1, jobIds: [job.id] })
    expect(port.query.mock.calls.map((call) => call[1].readOnly)).toEqual([true, true, false, true, false])
    const applied = port.query.mock.calls[4]![0]
    expect(applied).toContain('BEGIN;')
    expect(applied).toContain('SET LOCAL ROLE')
    expect(applied).toContain('UPDATE ONLY public.')
    expect(applied).toContain('NOBYPASSRLS')
    expect(applied).toContain("LIMIT 100 FOR UPDATE SKIP LOCKED")
  })
  it('applies already-configured jobs without reinstalling and accepts GMT as UTC', async () => {
    const port = provider([{ ...capability, timezone: 'GMT' }], [table], [{ applied: true, job_count: 1 }])
    await runJobs(port, options({ operation: 'cron-apply', manifest: { version: 1, jobs: [job] } }))
    expect(port.query).toHaveBeenCalledTimes(3)
    expect(port.query.mock.calls.some(([sql]) => sql.includes('CREATE EXTENSION'))).toBe(false)
  })
  it.each([{ rows: [] }, { rows: [{ ...table, rls: false }] }, { rows: [{ ...table, primary_key: [] }] }])('invalid table $rows never causes writes', async ({ rows }) => {
    const port = provider([{ ...capability, registry: false }], rows)
    await expect(runJobs(port, options({ operation: 'cron-apply', manifest: { version: 1, jobs: [job] } }))).rejects.toThrow(/Tabela/)
    expect(port.query.mock.calls.every((call) => call[1].readOnly)).toBe(true)
  })
  it('requires the entire manifest to validate before applying a single job', async () => {
    const port = provider([capability], [table], [])
    await expect(runJobs(port, options({ operation: 'cron-apply', manifest: { version: 1, jobs: [job, { ...job, id: 'another' }] } }))).rejects.toThrow('Tabela')
    expect(port.query.mock.calls.every((call) => call[1].readOnly)).toBe(true)
  })
  it('refuses unsupported timezone, unavailable bootstrap, and unconfirmed apply', async () => {
    const apply = options({ operation: 'cron-apply', manifest: { version: 1, jobs: [job] } })
    await expect(runJobs(provider([{ ...capability, timezone: 'America/New_York' }]), apply)).rejects.toThrow('UTC')
    await expect(runJobs(provider([{ ...capability, registry: false }], [table], []), apply)).rejects.toThrow('não foi confirmada')
    await expect(runJobs(provider([{ ...capability, registry: false }], [table], [{ ready: true }], [{ ...capability, registry: false }]), apply)).rejects.toThrow('não foi confirmado')
    await expect(runJobs(provider([capability], [table], [{ applied: true, job_count: 0 }]), apply)).rejects.toThrow('não foi confirmada')
  })
  it.each(['cron-pause', 'cron-resume', 'cron-remove'])('%s confirms only explicitly selected own job', async (operation) => {
    const port = provider([capability], [{ applied: true }])
    expect(await runJobs(port, options({ operation, jobId: job.id }))).toMatchObject({ applied: true, jobId: job.id })
    expect(port.query).toHaveBeenLastCalledWith(expect.stringContaining(projectId), { readOnly: false })
    expect(port.query.mock.calls[1]![0]).toContain(job.id)
    await expect(runJobs(provider([{ ...capability, registry: false }]), options({ operation, jobId: job.id }))).rejects.toThrow('Nenhum registro')
    await expect(runJobs(provider([capability], [{ applied: false }]), options({ operation, jobId: job.id }))).rejects.toThrow('não foi confirmada')
  })
})
