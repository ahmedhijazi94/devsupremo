import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runDatabase, runDatabaseDirect } from './database'
import { drainDatabaseRequests } from './database-queue'

const PROJECT = '11111111-1111-4111-8111-111111111111'
const CREDENTIAL = 'fixture-device-authorization-only'
const ISSUER = 'https://supremo.example.invalid'
const entrypoint = 'supabase/functions/send-email/index.ts'
const selection = { environment: 'development' as const, slug: 'send-email', entrypoint }
vi.mock('./daemon', () => ({ readProjectConfig: () => ({ projectId: PROJECT, apiBaseUrl: ISSUER }) }))
vi.mock('./keychain', () => ({ resolveKeychain: () => ({ get: () => JSON.stringify({ version: 1, projectId: PROJECT, issuer: ISSUER, secret: CREDENTIAL }) }) }))
let cwd: string
let status: { environment: string; projectRef: string | null }
let calls: { url: string; input: Record<string, unknown> }[]
beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'supremo-functions-daemon-'))
  fs.mkdirSync(path.join(cwd, '.supremo/database-queue'), { recursive: true })
  fs.mkdirSync(path.join(cwd, path.dirname(entrypoint)), { recursive: true })
  fs.writeFileSync(path.join(cwd, entrypoint), 'export const source = "initial daemon source";')
  status = { environment: 'development', projectRef: 'owned-development-ref' }
  calls = []
  vi.stubGlobal('fetch', vi.fn(async (url: URL, init: RequestInit) => {
    expect(init.redirect).toBe('error')
    const input = JSON.parse(String(init.body)) as Record<string, unknown>
    calls.push({ url: String(url), input })
    return Response.json(input.operation === 'status' ? status : {
      projectId: PROJECT, projectRef: status.projectRef, environment: status.environment, operation: input.operation,
      observedAt: '2026-09-24T12:00:00.000Z', execution: 'server_api', providerDashboardRequired: false, valuesReceived: false,
      readOnly: input.operation !== 'functions-deploy' && input.operation !== 'functions-hook-configure',
      data: { hook: { enabled: false, targetSlug: null, targetMatchesProject: false, signingSecretConfigured: false }, function: { slug: 'send-email', status: 'ACTIVE', version: 1, verifyJwt: true },
        deployed: true, verified: true, deliveryVerified: false },
    })
  }))
})
afterEach(() => {
  vi.unstubAllGlobals()
  fs.rmSync(cwd, { recursive: true, force: true })
})

describe('daemon-authorized Edge Function operations', () => {
  it('queues only a file selection; the daemon reads current source after confirming the target', async () => {
    const queue = path.join(cwd, '.supremo/database-queue')
    fs.writeFileSync(path.join(queue, 'heartbeat'), String(Date.now()))
    const pending = runDatabase('functions-deploy', cwd, selection)
    const request = fs.readdirSync(queue).find(name => name.endsWith('.request.json'))!
    const raw = fs.readFileSync(path.join(queue, request), 'utf8')
    expect(JSON.parse(raw)).toMatchObject({ operation: 'functions-deploy', options: { ...selection, files: [], verifyJwt: true } })
    expect(raw).not.toContain('initial daemon source')
    expect(raw).not.toContain(CREDENTIAL)
    expect(raw).not.toContain('expectedRef')
    expect(calls).toHaveLength(0)
    fs.writeFileSync(path.join(cwd, entrypoint), 'export const source = "current daemon source";')
    await drainDatabaseRequests(cwd, (operation, options) => runDatabaseDirect(operation, cwd, options))
    const result = await pending
    expect(calls.map(call => call.url)).toEqual([`${ISSUER}/api/database`, `${ISSUER}/api/functions`])
    expect(calls[1]!.input).toMatchObject({ operation: 'functions-deploy', projectId: PROJECT, deviceSecret: CREDENTIAL,
      expectedRef: 'owned-development-ref', environment: 'development', verifyJwt: true,
      files: [{ path: entrypoint, content: 'export const source = "current daemon source";' }],
    })
    expect(JSON.stringify(result)).not.toContain(CREDENTIAL)
    expect(JSON.stringify(result)).not.toContain('current daemon source')
    expect(fs.readdirSync(queue)).toEqual(['heartbeat'])
  })

  it.each(['production', 'unknown'])('refuses a %s target after only the fresh status request', async environment => {
    status.environment = environment
    fs.unlinkSync(path.join(cwd, entrypoint))
    await expect(runDatabaseDirect('functions-deploy', cwd, selection)).rejects.toThrow(/explicitamente selecionado/)
    expect(calls).toEqual([{ url: `${ISSUER}/api/database`, input: { operation: 'status', projectId: PROJECT, deviceSecret: CREDENTIAL } }])
  })

  it('publishes to production only when the explicit selector matches fresh server authority', async () => {
    status.environment = 'production'
    await runDatabaseDirect('functions-deploy', cwd, { ...selection, environment: 'production' })
    expect(calls[1]!.input).toMatchObject({ environment: 'production', expectedRef: 'owned-development-ref' })
    expect(calls[1]!.url).toBe(`${ISSUER}/api/functions`)
  })

  it('refuses an invalid provider reference before dispatching a function operation', async () => {
    status.projectRef = null
    await expect(runDatabaseDirect('functions-hook-configure', cwd, { environment: 'development', slug: 'send-email' })).rejects.toThrow(/explicitamente selecionado/)
    expect(calls.map(call => call.input.operation)).toEqual(['status'])
  })

  it('binds each operation to the fresh server ref, ignoring old cache and local environment selectors', async () => {
    fs.writeFileSync(path.join(cwd, '.supremo/database.json'), JSON.stringify({ environment: 'development', projectRef: 'stale-ref' }))
    fs.writeFileSync(path.join(cwd, '.env.local'), 'SUPABASE_URL=https://foreign-ref.supabase.co\n')
    await runDatabaseDirect('functions-status', cwd, { environment: 'development', slug: 'send-email' })
    status.projectRef = 'new-owned-development-ref'
    await runDatabaseDirect('functions-hook-status', cwd, { environment: 'development' })
    expect(calls.map(call => call.input.operation)).toEqual(['status', 'functions-status', 'status', 'functions-hook-status'])
    expect(calls[1]!.input.expectedRef).toBe('owned-development-ref')
    expect(calls[3]!.input.expectedRef).toBe('new-owned-development-ref')
    expect(calls.filter(call => call.url.endsWith('/api/functions')).every(call => call.input.environment === 'development')).toBe(true)
  })

  it.each([
    { ...selection, environment: 'unknown' },
    { ...selection, expectedRef: 'foreign-ref' },
    { ...selection, url: 'https://foreign.example.invalid' },
    { ...selection, deviceSecret: 'injected-credential' },
    { ...selection, files: [{ path: entrypoint, content: 'injected source' }] },
  ])('rejects untrusted options before any authenticated request: %j', async options => {
    await expect(runDatabaseDirect('functions-deploy', cwd, options as never)).rejects.toThrow()
    expect(calls).toHaveLength(0)
  })
})
