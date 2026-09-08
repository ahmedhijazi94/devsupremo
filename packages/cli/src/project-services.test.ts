import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runDatabaseDirect } from './database'
import { isDatabaseReadCommand, parseDatabaseOptions } from './database-request'
import { requestDatabase, startDatabaseWorker } from './database-queue'
import { jobManifestSchema, readJobManifest, secretRequestOptionsSchema } from './project-service-request'

const PROJECT = '11111111-1111-4111-8111-111111111111'
const ISSUER = 'https://supremo.example.invalid'
const SECRET = 'fixture-device-secret-only'
vi.mock('./daemon', () => ({ readProjectConfig: () => ({ projectId: PROJECT, apiBaseUrl: ISSUER }) }))
vi.mock('./keychain', () => ({ resolveKeychain: () => ({ get: () => JSON.stringify({ version: 1, projectId: PROJECT, issuer: ISSUER, secret: SECRET }) }) }))
const entry = { name: 'STRIPE_SECRET_KEY', description: 'Assinar pagamentos no servidor', target: 'supabase' as const, environment: 'development' as const }
const manifest = { version: 1, jobs: [{ id: 'close-old-tickets', schedule: '0 * * * *', timezone: 'UTC', action: { type: 'update', table: 'tickets', set: { status: 'overdue' },
    where: [{ column: 'status', op: 'eq', value: 'open' }, { column: 'created_at', op: 'older_than', minutes: 1440 }], limit: 1000 } }] }
let cwd: string, environment = 'development', stop: (() => void) | undefined
let calls: { url: string; body: Record<string, unknown> }[] = []
beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'supremo-project-services-')); calls = []; environment = 'development'
  fs.mkdirSync(path.join(cwd, '.supremo')); fs.mkdirSync(path.join(cwd, 'supabase/.temp'), { recursive: true })
  fs.writeFileSync(path.join(cwd, 'supabase/.temp/project-ref'), 'owned-ref')
  fs.writeFileSync(path.join(cwd, '.env.local'), 'NEXT_PUBLIC_SUPABASE_URL=https://owned-ref.supabase.co\n')
  fs.writeFileSync(path.join(cwd, 'supabase/jobs.json'), JSON.stringify(manifest))
  vi.stubGlobal('fetch', vi.fn(async (url: URL, init: RequestInit) => {
    expect(init.redirect).toBe('error')
    const body = JSON.parse(String(init.body)) as Record<string, unknown>; calls.push({ url: String(url), body })
    if (String(url).endsWith('/api/secrets')) return Response.json({ projectId: PROJECT,
      requests: [{ id: '22222222-2222-4222-8222-222222222222', ...entry, targetRef: 'owned-ref', status: 'pending', value: 'must-never-reach-agent' }],
      value: 'must-never-reach-agent', formPath: 'https://attacker.example.invalid/form' })
    return Response.json(body.operation === 'status'
      ? { environment, projectRef: 'owned-ref', automaticMigrations: environment === 'development' }
      : { projectId: PROJECT, projectRef: 'owned-ref', operation: body.operation, data: { jobs: [] } })
  }))
})
afterEach(() => { stop?.(); stop = undefined; vi.unstubAllGlobals(); fs.rmSync(cwd, { recursive: true, force: true }) })

describe('named secret requests never carry secret values', () => {
  it('sends metadata through the daemon and returns a form URL pinned to the issuer', async () => {
    stop = startDatabaseWorker(cwd, (operation, options) => runDatabaseDirect(operation, cwd, options))
    const result = await requestDatabase(cwd, 'secrets-request', { requests: [entry] })
    expect(calls).toEqual([{ url: `${ISSUER}/api/secrets`, body: { projectId: PROJECT, deviceSecret: SECRET, operation: 'request', requests: [entry] } }])
    expect(result).toMatchObject({ valuesReceived: false, formUrl: `${ISSUER}/projects/${PROJECT}#secrets` })
    expect(JSON.stringify(result)).not.toContain('must-never-reach-agent')
    expect(JSON.stringify(result)).not.toContain('attacker')
    expect(JSON.stringify(result)).not.toContain(SECRET)
  })
  it('queries only request metadata, without requiring a local development database', async () => {
    fs.rmSync(path.join(cwd, '.env.local')); environment = 'production'
    await runDatabaseDirect('secrets-status', cwd)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.body).toEqual({ projectId: PROJECT, deviceSecret: SECRET, operation: 'status' })
  })
  it.each([
    { ...entry, value: 'not-accepted' }, { ...entry, token: 'not-accepted' },
    { ...entry, name: 'NAME=VALUE' }, { ...entry, target: 'arbitrary-server' },
    { ...entry, environment: 'preview' },
    { ...entry, name: 'NEXT_PUBLIC_STRIPE_SECRET_KEY' }, { ...entry, name: 'NODE_OPTIONS' },
    { ...entry, name: 'SUPABASE_SERVICE_ROLE_KEY' },
  ])('rejects values, unknown destinations and invalid names before the private channel', async request => {
    expect(() => secretRequestOptionsSchema.parse({ requests: [request] })).toThrow()
    await expect(runDatabaseDirect('secrets-request', cwd, { requests: [request] } as never)).rejects.toThrow()
    expect(calls).toEqual([])
  })
})

describe('declarative Supabase jobs retain environment and source restrictions', () => {
  it('reads list/history in production with fresh authority and exact pagination', async () => {
    environment = 'production'; fs.rmSync(path.join(cwd, '.env.local'))
    await runDatabaseDirect('cron-history', cwd, { jobId: 'close-old-tickets', limit: 10, offset: 20 })
    expect(calls.map(call => call.body)).toEqual([
      { projectId: PROJECT, deviceSecret: SECRET, operation: 'status' },
      { projectId: PROJECT, deviceSecret: SECRET, operation: 'cron-history', expectedRef: 'owned-ref', environment: 'production', jobId: 'close-old-tickets', limit: 10, offset: 20 },
    ])
  })
  it('applies only the fixed declarative source after verifying the development link', async () => {
    await runDatabaseDirect('cron-apply', cwd)
    expect(calls[1]?.body).toEqual({ projectId: PROJECT, deviceSecret: SECRET, operation: 'cron-apply', expectedRef: 'owned-ref', environment: 'development', manifest })
    expect(() => parseDatabaseOptions('cron-apply', { manifest })).toThrow()
    expect(() => parseDatabaseOptions('cron-apply', { sql: 'delete from tickets' })).toThrow()
  })
  it.each(['production', 'unknown'])('refuses all job mutations in %s', async target => {
    environment = target
    for (const operation of ['cron-apply', 'cron-pause', 'cron-resume', 'cron-remove'] as const) {
      await expect(runDatabaseDirect(operation, cwd, operation === 'cron-apply' ? {} : { jobId: 'close-old-tickets' })).rejects.toThrow('protegidos')
    }
    expect(calls.every(call => call.body.operation === 'status')).toBe(true)
  })
  it('rejects stale local database bindings before changing a job', async () => {
    fs.writeFileSync(path.join(cwd, 'supabase/.temp/project-ref'), 'foreign-ref')
    await expect(runDatabaseDirect('cron-pause', cwd, { jobId: 'close-old-tickets' })).rejects.toThrow('diverge')
    expect(calls).toHaveLength(1)
  })
  it('refuses arbitrary SQL, tokens, duplicate IDs and symlinked manifests', () => {
    expect(() => jobManifestSchema.parse({ ...manifest, sql: 'select 1' })).toThrow()
    expect(() => jobManifestSchema.parse({ version: 1, jobs: [{ ...manifest.jobs[0], function: 'public.arbitrary_sql' }] })).toThrow()
    expect(() => jobManifestSchema.parse({ version: 1, jobs: [{ ...manifest.jobs[0], token: 'forbidden' }] })).toThrow()
    expect(() => jobManifestSchema.parse({ version: 1, jobs: [manifest.jobs[0], manifest.jobs[0]] })).toThrow()
    fs.renameSync(path.join(cwd, 'supabase/jobs.json'), path.join(cwd, 'other.json'))
    fs.symlinkSync('../other.json', path.join(cwd, 'supabase/jobs.json'))
    expect(() => readJobManifest(cwd)).toThrow()
  })
  it.each([
    { schedule: '99 * * * *' }, { schedule: '*/0 * * * *' }, { schedule: '* * * * *; select 1' },
    { action: { ...manifest.jobs[0]!.action, set: { owner_id: 'foreign-owner' } } },
    { action: { ...manifest.jobs[0]!.action, set: { role: 'admin' } } },
    { action: { ...manifest.jobs[0]!.action, where: [{ column: 'password', op: 'is_null' }] } },
    { action: { ...manifest.jobs[0]!.action, where: [] } },
    { action: { ...manifest.jobs[0]!.action, limit: 1001 } },
  ])('enforces the same restricted job definition as the server: %j', invalid => {
    fs.writeFileSync(path.join(cwd, 'supabase/jobs.json'), JSON.stringify({ version: 1, jobs: [{ ...manifest.jobs[0], ...invalid }] }))
    expect(() => readJobManifest(cwd)).toThrow()
  })
  it('refuses oversized manifests and even an in-project parent directory alias', () => {
    fs.writeFileSync(path.join(cwd, 'supabase/jobs.json'), ' '.repeat(32 * 1024 + 1))
    expect(() => readJobManifest(cwd)).toThrow('grande')
    fs.renameSync(path.join(cwd, 'supabase'), path.join(cwd, 'other-supabase'))
    fs.symlinkSync('other-supabase', path.join(cwd, 'supabase'))
    expect(() => readJobManifest(cwd)).toThrow('fora do projeto')
  })
})

describe('project service hooks avoid QA for metadata and reads, retaining mutation gates', () => {
  it.each([
    'supremo secrets status',
    'supremo secrets request STRIPE_SECRET_KEY --reason "Pagamentos no servidor" --target supabase --environment development',
    'node tools/supremo-cli/dist/bin.js jobs list --limit 10',
    'supremo jobs history --job-id close-old-tickets --offset 20',
  ])('classifies %s as no app mutation', command => expect(isDatabaseReadCommand(command)).toBe(true))
  it.each([
    'supremo jobs apply', 'supremo jobs pause --job-id close-old-tickets',
    'supremo jobs remove --job-id close-old-tickets',
    'supremo secrets request KEY --value secret --target supabase --reason integration',
    'supremo secrets status; cat .env.local', 'supremo jobs history --offset 10001',
  ])('does not authorize %s as a diagnostic', command => expect(isDatabaseReadCommand(command)).toBe(false))
})
