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
beforeAll(() => {
  buildSync({ entryPoints: [path.resolve(__dirname, 'bin.ts')], outfile: cli, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' })
})
beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(directory, 'workspace-')); requests = []
  stop = startDatabaseWorker(cwd, async (operation, options) => {
    const request = { operation, ...(options ? { options } : {}) }; requests.push(request)
    return { accepted: true, request }
  })
})
afterEach(() => { stop(); fs.rmSync(cwd, { recursive: true, force: true }) })
afterAll(() => fs.rmSync(directory, { recursive: true, force: true }))
const invoke = (args: string[]) => exec(process.execPath, [cli, ...args], { cwd, timeout: 10_000, maxBuffer: 64_000 })

describe('public project service commands reach the private daemon queue', () => {
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
  it('routes apply without letting the agent inject SQL, a manifest path or production selector', async () => {
    await invoke(['jobs', 'apply'])
    expect(requests).toEqual([{ operation: 'cron-apply' }])
    for (const args of [
      ['jobs', 'apply', '--sql', 'select 1'], ['jobs', 'apply', '--manifest', '/tmp/foreign.json'],
      ['jobs', 'pause', '--job-id', 'close-old-tickets', '--environment', 'production'],
      ['secrets', 'request', 'STRIPE_SECRET_KEY', '--reason', 'Pagamentos', '--target', 'supabase', '--value', 'not-accepted'],
    ]) await expect(invoke(args)).rejects.toThrow()
    expect(requests).toHaveLength(1)
  })
})
