import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runDatabaseDirect } from './database'
import { isDatabaseReadCommand, parseDatabaseOptions } from './database-request'
import { requestDatabase, startDatabaseWorker } from './database-queue'
import { captureTree, gitText } from './turn-workspace'

const PROJECT = '11111111-1111-4111-8111-111111111111'
const CREDENTIAL = 'fixture-device-authorization-only'
vi.mock('./daemon', () => ({ readProjectConfig: () => ({ projectId: PROJECT, apiBaseUrl: configuredUrl }) }))
vi.mock('./keychain', () => ({ resolveKeychain: () => ({ get: () => storedCredential }) }))
let configuredUrl = 'https://supremo.example.invalid'
let storedCredential = ''
let cwd: string
let stop: (() => void) | undefined
let environment = 'production'
let calls: Record<string, unknown>[] = []
beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'supremo-data-inspection-'))
  fs.mkdirSync(path.join(cwd, '.supremo'))
  calls = []; environment = 'production'
  configuredUrl = 'https://supremo.example.invalid'
  storedCredential = JSON.stringify({ version: 1, projectId: PROJECT, issuer: configuredUrl, secret: CREDENTIAL })
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    expect(init.redirect).toBe('error')
    const input = JSON.parse(String(init.body)) as Record<string, unknown>
    calls.push(input)
    return Response.json(input.operation === 'status'
      ? { environment, projectRef: 'owned-ref', automaticMigrations: environment === 'development' }
      : { projectId: PROJECT, projectRef: 'owned-ref', environment, operation: input.operation, readOnly: true,
        observedAt: new Date().toISOString(), data: { rows: [{ title: 'Chamado A' }], rowCount: 1 }, untrustedData: true })
  }))
})
afterEach(() => { stop?.(); stop = undefined; vi.unstubAllGlobals(); fs.rmSync(cwd, { recursive: true, force: true }) })

describe('authorized database reads through the daemon', () => {
  it.each(['development', 'production', 'unknown'])('reads %s only with fresh status and exact target, without local .env', async target => {
    environment = target
    const result = await runDatabaseDirect('query', cwd, { sql: 'select title from public.tickets', limit: 20, offset: 40 })
    expect(result).toMatchObject({ readOnly: true, environment: target, untrustedData: true })
    expect(calls).toEqual([
      { operation: 'status', projectId: PROJECT, deviceSecret: CREDENTIAL },
      { operation: 'query', projectId: PROJECT, deviceSecret: CREDENTIAL, expectedRef: 'owned-ref', environment: target,
        sql: 'select title from public.tickets', limit: 20, offset: 40 },
    ])
    expect(fs.existsSync(path.join(cwd, '.env.local'))).toBe(false)
  })
  it('refuses a tampered checkout backend before any credential-bearing request', async () => {
    configuredUrl = 'https://attacker.example.invalid'
    await expect(runDatabaseDirect('query', cwd, { sql: 'select 1' })).rejects.toThrow('Origem')
    expect(calls).toEqual([])
  })
  it('refuses a legacy credential without a privately recorded origin instead of trusting project.json', async () => {
    storedCredential = CREDENTIAL
    await expect(runDatabaseDirect('status', cwd)).rejects.toThrow('sem origem verificável')
    expect(calls).toEqual([])
  })
  it('passes log/report pagination to the backend after fresh authority', async () => {
    await runDatabaseDirect('logs', cwd, { offset: 50, limit: 25 })
    expect(calls[1]).toMatchObject({ operation: 'logs', offset: 50, limit: 25 })
    await runDatabaseDirect('report', cwd, { offset: 75 })
    expect(calls[3]).toMatchObject({ operation: 'report', offset: 75 })
  })
  it('rejects mismatched requested environment without sending the query', async () => {
    await expect(runDatabaseDirect('inspect', cwd, { environment: 'development' })).rejects.toThrow('diverge')
    expect(calls).toHaveLength(1)
  })
  it('transports structured logs/report controls with no arbitrary target or credential fields', async () => {
    await runDatabaseDirect('logs', cwd, { source: 'auth', minutes: 15, level: 'error', limit: 30 })
    expect(calls[1]).toMatchObject({ operation: 'logs', source: 'auth', minutes: 15, level: 'error', limit: 30, environment: 'production', expectedRef: 'owned-ref' })
    await expect(runDatabaseDirect('report', cwd, { expectedRef: 'foreign' } as never)).rejects.toThrow()
    expect(calls).toHaveLength(2)
  })
  it('keeps migration protections and refuses read-only selectors on mutation commands', async () => {
    await expect(runDatabaseDirect('migrate', cwd)).rejects.toThrow('protegidos')
    await expect(runDatabaseDirect('migrate', cwd, { environment: 'production' })).rejects.toThrow()
    expect(calls).toHaveLength(1)
  })
  it('agent receives actual rows through the local queue while only the daemon handles device credentials', async () => {
    stop = startDatabaseWorker(cwd, (operation, options) => runDatabaseDirect(operation, cwd, options))
    const result = await requestDatabase(cwd, 'query', { sql: 'select title from public.tickets' })
    expect(result).toMatchObject({ data: { rows: [{ title: 'Chamado A' }] } })
    expect(JSON.stringify(result)).not.toContain(CREDENTIAL)
    expect(fs.readdirSync(path.join(cwd, '.supremo/database-queue'))).toEqual(['heartbeat'])
  })
  it('never captures inspection cache/queue data even if accidentally tracked or missing ignore rules', () => {
    gitText(cwd, ['init', '-b', 'main']); gitText(cwd, ['config', 'user.name', 'Fixture']); gitText(cwd, ['config', 'user.email', 'fixture@example.invalid'])
    fs.mkdirSync(path.join(cwd, '.supremo/database-queue'))
    fs.writeFileSync(path.join(cwd, '.supremo/database-queue/test.response.json'), '{"sensitiveBusinessData":"private"}')
    fs.writeFileSync(path.join(cwd, '.supremo/database.json'), '{"projectRef":"private-cache"}')
    fs.writeFileSync(path.join(cwd, 'app.ts'), 'export const app = 1;')
    gitText(cwd, ['add', '-A']); gitText(cwd, ['commit', '-m', 'fixture'])
    const snapshot = captureTree(cwd)
    const files = gitText(cwd, ['ls-tree', '-r', '--name-only', snapshot.treeSha])
    expect(files).not.toContain('database')
    expect(files).toContain('app.ts')
  })
})

describe('read diagnostics remain bounded and cannot become shell commands', () => {
  it.each([
    'supremo db inspect --table tickets --limit 50',
    'supremo db query --sql "select count(*) from public.tickets"',
    "node tools/supremo-cli/dist/bin.js db query 'select title from public.tickets' --limit 10",
    'supremo db logs --source auth --minutes 15 --level error',
    'supremo db report --environment production',
  ])('allows the literal read operation %s', command => expect(isDatabaseReadCommand(command)).toBe(true))
  it.each([
    'supremo db migrate', 'supremo db anonymous-auth', 'supremo db query --sql "$(cat .env.local)"',
    'supremo db logs; rm app.ts', 'supremo db status && node evil.js', 'supremo db inspect --expectedRef foreign',
    'node --eval evil db query select', 'supremo db query --sql select --limit 201',
  ])('refuses mutation, expansion, composition or unknown selector %s', command => expect(isDatabaseReadCommand(command)).toBe(false))
  it('rejects invalid query/log limits and SQL on non-query operations', () => {
    expect(() => parseDatabaseOptions('query', { sql: 'x'.repeat(12_001) })).toThrow()
    expect(() => parseDatabaseOptions('query', { sql: 'select 1', offset: 10_001 })).toThrow()
    expect(() => parseDatabaseOptions('logs', { minutes: 1441 })).toThrow()
    expect(() => parseDatabaseOptions('inspect', { sql: 'select 1' })).toThrow()
  })
})
