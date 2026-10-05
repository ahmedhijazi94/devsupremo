import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { artifactDigest } from '../../../src/lib/sql-artifacts/service'
import { startSqlArtifactWorker } from './sql-artifacts'
import type { DaemonConfig } from './daemon'

const projectId = '11111111-1111-4111-8111-111111111111'
const id = '22222222-2222-4222-8222-222222222222'
const claimToken = '33333333-3333-4333-8333-333333333333'
const issuer = 'https://supremo.example.invalid/installation'
const credential = 'fixture-device-authorization-only'
const content = 'create table public.notes(id uuid primary key);'
const file = 'supabase/migrations/20261005123456_11111111111141118111111111111111.sql'
let cwd: string
let stop: (() => void) | undefined
let config: DaemonConfig
beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'supremo-sql-transport-'))
  fs.mkdirSync(path.join(cwd, 'supabase/.temp'), { recursive: true })
  fs.writeFileSync(path.join(cwd, 'supabase/.temp/project-ref'), 'owned-ref')
  fs.writeFileSync(path.join(cwd, '.env.local'), 'NEXT_PUBLIC_SUPABASE_URL=https://owned-ref.supabase.co\nPRIVATE_FIXTURE=must-stay-local\n')
  config = { projectId, apiBaseUrl: `${issuer}/`, cwd, getSecret: () => credential }
  vi.spyOn(process.stderr, 'write').mockReturnValue(true)
})
afterEach(() => { stop?.(); stop = undefined; vi.unstubAllGlobals(); vi.restoreAllMocks(); fs.rmSync(cwd, { recursive: true, force: true }) })
const sample = () => ({ id, projectId, projectRef: 'owned-ref', environment: 'development', path: file, content,
  digest: artifactDigest(content), state: 'materializing', claimToken, types: null, message: '', updatedAt: '2026-10-05T12:00:00Z' })

it('sends only scoped identifiers and receipts to the bound installation, never SQL or environment files', async () => {
  const calls: Record<string, unknown>[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    expect(url).toBe(`${issuer}/api/sql-artifacts`)
    expect(init.redirect).toBe('error')
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    calls.push(body)
    return Response.json({ projectId, artifact: { ...sample(), state: body.operation === 'poll' ? 'materializing' : body.operation === 'materialized' ? 'materialized' : 'failed' } })
  }))
  stop = startSqlArtifactWorker(config)
  await vi.waitFor(() => expect(calls).toHaveLength(3))
  expect(calls).toEqual([
    { projectId, expectedRef: 'owned-ref', deviceSecret: credential, operation: 'poll', sessionId: expect.any(String), ready: true },
    { projectId, expectedRef: 'owned-ref', deviceSecret: credential, operation: 'materialized', id, claimToken, digest: artifactDigest(content) },
    { projectId, expectedRef: 'owned-ref', deviceSecret: credential, operation: 'advance', id, claimToken },
  ])
  expect(JSON.stringify(calls)).not.toContain(content)
  expect(JSON.stringify(calls)).not.toContain('must-stay-local')
})

it.each([{ projectId: id }, { projectRef: 'foreign-ref' }])('rejects a response outside the requested scope: %j', async mismatch => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ projectId, artifact: { ...sample(), ...mismatch } })))
  stop = startSqlArtifactWorker(config)
  await vi.waitFor(() => expect(process.stderr.write).toHaveBeenCalledOnce())
  expect(fetch).toHaveBeenCalledOnce()
  expect(fs.existsSync(path.join(cwd, file))).toBe(false)
})

it('refuses arbitrary local file content in the reference before sending a request', async () => {
  fs.writeFileSync(path.join(cwd, 'supabase/.temp/project-ref'), 'local\nprivate\nfixture')
  vi.stubGlobal('fetch', vi.fn())
  stop = startSqlArtifactWorker(config)
  await vi.waitFor(() => expect(process.stderr.write).toHaveBeenCalledOnce())
  expect(fetch).not.toHaveBeenCalled()
})
