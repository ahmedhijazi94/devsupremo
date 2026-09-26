import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { buildSync } from 'esbuild'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { startDatabaseWorker } from './database-queue'
import type { DatabaseOperation, DatabaseOptions } from './database-request'

const exec = promisify(execFile)
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'supremo-services-cli-'))
const cli = path.join(directory, 'cli.cjs')
let cwd: string, stop: () => void
let requests: { operation: DatabaseOperation; options?: DatabaseOptions }[] = []
let reply: ((operation: DatabaseOperation, options?: DatabaseOptions) => unknown) | undefined
beforeAll(() => {
  buildSync({ entryPoints: [path.resolve(__dirname, 'bin.ts')], outfile: cli, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' })
})
beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(directory, 'workspace-')); requests = []; reply = undefined
  stop = startDatabaseWorker(cwd, async (operation, options) => {
    const request = { operation, ...(options ? { options } : {}) }; requests.push(request)
    return reply ? reply(operation, options) : { accepted: true, request }
  })
})
afterEach(() => { stop(); fs.rmSync(cwd, { recursive: true, force: true }) })
afterAll(() => fs.rmSync(directory, { recursive: true, force: true }))
const invoke = (args: string[]) => exec(process.execPath, [cli, ...args], { cwd, timeout: 10_000, maxBuffer: 64_000 })

describe('public project service commands reach the private daemon queue', () => {
  it('exposes vault metadata aliases and exact reference application without plaintext arguments', async () => {
    const credentialId = '33333333-3333-4333-8333-333333333333', requestId = '22222222-2222-4222-8222-222222222222'
    await invoke(['integrations', 'credentials'])
    await invoke(['secrets', 'credentials'])
    await invoke(['secrets', 'status', '--request-id', requestId])
    await invoke(['integrations', 'apply', requestId, '--credential-id', credentialId])
    await invoke(['secrets', 'revoke-credential', credentialId])
    expect(requests).toEqual([
      { operation: 'secrets-credentials' }, { operation: 'secrets-credentials' },
      { operation: 'secrets-status', options: { requestId } },
      { operation: 'secrets-apply', options: { requestId, credentialId } },
      { operation: 'secrets-revoke-credential', options: { credentialId } },
    ])
  })
  it.each(['email', 'request'])('creates and applies the exact %s request without opening a form', async kind => {
    const credentialId = '33333333-3333-4333-8333-333333333333', requestId = '22222222-2222-4222-8222-222222222222'
    let entry: NonNullable<DatabaseOptions['requests']>[number]
    reply = (operation, options) => {
      if (operation === 'secrets-request') entry = options!.requests![0]!
      return { projectId: '11111111-1111-4111-8111-111111111111', requests: [{
        id: requestId, ...entry, targetRef: 'owned-ref', status: operation === 'secrets-apply' ? 'fulfilled' : 'pending',
      }] }
    }
    const args = kind === 'email'
      ? ['integrations', 'email', '--provider', 'resend', '--sender-email', 'hello@example.invalid', '--environment', 'development']
      : ['integrations', 'request', 'RESEND_API_KEY', '--reason', 'Enviar emails', '--target', 'supabase']
    const result = await invoke([...args, '--credential-id', credentialId])
    expect(requests).toHaveLength(2)
    expect(requests[1]).toEqual({ operation: 'secrets-apply', options: { requestId, credentialId } })
    expect(JSON.parse(result.stdout).requests[0].status).toBe('fulfilled')
  })
  it('requests exact names with explicit destination and defaults the environment safely', async () => {
    const result = await invoke(['secrets', 'request', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', '--reason', 'Pagamentos no servidor', '--target', 'supabase'])
    expect(JSON.parse(result.stdout).accepted).toBe(true)
    expect(requests).toEqual([{ operation: 'secrets-request', options: { requests: ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'].map(name => ({
      name, description: 'Pagamentos no servidor', target: 'supabase', environment: 'development',
    })) } }])
  })
  it('routes paginated job history and secret status without mutating application files', async () => {
    await invoke(['jobs', 'history', '--job-id', 'close-old-tickets', '--offset', '20', '--limit', '10', '--environment', 'production'])
    await invoke(['secrets', 'status'])
    expect(requests).toEqual([
      { operation: 'cron-history', options: { jobId: 'close-old-tickets', offset: 20, limit: 10, environment: 'production' } },
      { operation: 'secrets-status' },
    ])
    expect(fs.readdirSync(cwd)).toEqual(['.supremo'])
  })
  it('preserves explicit production selectors', async () => {
    await invoke(['jobs', 'apply', '--environment', 'production'])
    await invoke(['jobs', 'pause', '--job-id', 'close-old-tickets', '--environment', 'production'])
    expect(requests).toEqual([{ operation: 'cron-apply', options: { environment: 'production' } }, { operation: 'cron-pause', options: { jobId: 'close-old-tickets', environment: 'production' } }])
  })
  it('emits an authenticated cron scaffold locally without queuing or overwriting files', async () => {
    fs.writeFileSync(path.join(cwd,'.supremo/project.json'), JSON.stringify({ projectId: '11111111-1111-4111-8111-111111111111', supremoUrl: 'https://supremo.example.invalid' }))
    const result=JSON.parse((await invoke(['jobs','scaffold','--slug','daily-report'])).stdout)
    expect(result).toMatchObject({ implemented:false, path:'supabase/functions/daily-report/index.ts' })
    expect(result.source).toContain('crypto.subtle.verify')
    expect(requests).toEqual([])
    expect(fs.existsSync(path.join(cwd,'supabase'))).toBe(false)
  })
  it('routes apply without letting the agent inject SQL, a manifest path or unknown environment selector', async () => {
    await invoke(['jobs', 'apply'])
    expect(requests).toEqual([{ operation: 'cron-apply' }])
    for (const args of [
      ['jobs', 'apply', '--sql', 'select 1'], ['jobs', 'apply', '--manifest', '/tmp/foreign.json'],
      ['jobs', 'pause', '--job-id', 'close-old-tickets', '--environment', 'unknown'],
      ['secrets', 'request', 'STRIPE_SECRET_KEY', '--reason', 'Pagamentos', '--target', 'supabase', '--value', 'not-accepted'],
    ]) await expect(invoke(args)).rejects.toThrow()
    expect(requests).toHaveLength(1)
  })
})
