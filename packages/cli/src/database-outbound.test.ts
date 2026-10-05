import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { runDatabaseDirect } from './database'

const projectId = '11111111-1111-4111-8111-111111111111'
const issuer = 'https://supremo.example.invalid/installation'
const credential = 'fixture-device-authorization-only'
const migration = '20261005120000_notes.sql'
vi.mock('./daemon', () => ({ readProjectConfig: () => ({ projectId, apiBaseUrl: `${issuer}/` }) }))
vi.mock('./keychain', () => ({ resolveKeychain: () => ({ get: () => JSON.stringify({ version: 1, projectId, issuer, secret: credential }) }) }))
let cwd: string
let calls: { url: string; body: Record<string, unknown> }[]
beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'supremo-database-outbound-'))
  fs.mkdirSync(path.join(cwd, '.supremo'))
  fs.mkdirSync(path.join(cwd, 'supabase/.temp'), { recursive: true })
  fs.mkdirSync(path.join(cwd, 'supabase/migrations'))
  fs.writeFileSync(path.join(cwd, 'supabase/.temp/project-ref'), 'owned-ref')
  fs.writeFileSync(path.join(cwd, '.env.local'), 'NEXT_PUBLIC_SUPABASE_URL=https://owned-ref.supabase.co\nPRIVATE_FIXTURE=must-stay-local\n')
  calls = []
  vi.stubGlobal('fetch', vi.fn(async (url: URL, init: RequestInit) => {
    expect(init.redirect).toBe('error')
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    calls.push({ url: String(url), body })
    return Response.json(body.operation === 'status'
      ? { environment: 'development', projectRef: 'owned-ref', automaticMigrations: true }
      : { projectId, operation: body.operation, applied: [migration] })
  }))
})
afterEach(() => { vi.unstubAllGlobals(); fs.rmSync(cwd, { recursive: true, force: true }) })

it('uploads only versioned SQL and keeps the destination bound to the authorized installation', async () => {
  const content = 'create table public.notes(id uuid primary key);'
  fs.writeFileSync(path.join(cwd, 'supabase/migrations', migration), content)
  fs.writeFileSync(path.join(cwd, 'supabase/migrations/private.txt'), 'must-stay-local')
  await runDatabaseDirect('migrate', cwd)
  expect(calls.map(call => call.url)).toEqual([`${issuer}/api/database`, `${issuer}/api/database`])
  expect(calls[1]?.body).toEqual({ projectId, deviceSecret: credential, operation: 'migrate', expectedRef: 'owned-ref',
    operationId: expect.any(String), migrations: [{ path: `supabase/migrations/${migration}`, content }] })
  expect(JSON.stringify(calls)).not.toContain('must-stay-local')
})

it.each(['file', 'directory'])('refuses a symlinked migration %s before sending any local source', async selection => {
  const external = fs.mkdtempSync(path.join(os.tmpdir(), 'supremo-database-external-'))
  try {
    fs.writeFileSync(path.join(external, migration), 'private external fixture')
    const directory = path.join(cwd, 'supabase/migrations')
    if (selection === 'directory') { fs.rmdirSync(directory); fs.symlinkSync(external, directory) }
    else fs.symlinkSync(path.join(external, migration), path.join(directory, migration))
    await expect(runDatabaseDirect('migrate', cwd)).rejects.toThrow()
    expect(calls.map(call => call.body.operation)).toEqual(['status'])
  } finally { fs.rmSync(external, { recursive: true, force: true }) }
})

it.each(['invalid-name', 'large-file', 'many-files', 'large-request'])('rejects %s before upload', async selection => {
  const directory = path.join(cwd, 'supabase/migrations')
  if (selection === 'invalid-name') fs.writeFileSync(path.join(directory, 'private.sql'), 'local fixture')
  if (selection === 'large-file') fs.writeFileSync(path.join(directory, migration), 'x'.repeat(250_001))
  if (selection === 'many-files') for (let index = 0; index < 101; index++) fs.writeFileSync(path.join(directory, `20261005120000_file${index}.sql`), 'select 1;')
  if (selection === 'large-request') for (let index = 0; index < 5; index++) fs.writeFileSync(path.join(directory, `20261005120000_file${index}.sql`), 'x'.repeat(250_000))
  await expect(runDatabaseDirect('migrate', cwd)).rejects.toThrow()
  expect(calls.map(call => call.body.operation)).toEqual(['status'])
})
