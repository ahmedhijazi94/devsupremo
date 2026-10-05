import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { isDatabaseReadCommand, parseDatabaseOptions } from './database-request'
import { drainDurableOperations, enqueueDatabaseOperation, readDurableOperation, resumeDatabaseOperation } from './durable-operations'
import { runDatabaseDirect } from './database'

const projectId = '11111111-1111-4111-8111-111111111111'
const issuer = 'https://supremo.example.invalid'
vi.mock('./daemon', () => ({ readProjectConfig: () => ({ projectId, apiBaseUrl: issuer }) }))
vi.mock('./keychain', () => ({ resolveKeychain: () => ({ get: () => JSON.stringify({ version: 1, projectId, issuer, secret: 'fixture-device-value' }) }) }))
const options = { environment: 'development', email: 'person@example.test', redirectTo: 'https://app.test/callback' } as const
const dirs: string[] = []
const workspace = () => { const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'supremo-invite-')); dirs.push(cwd); fs.mkdirSync(path.join(cwd, '.supremo')); return cwd }
afterEach(() => { vi.unstubAllGlobals(); for (const cwd of dirs.splice(0)) fs.rmSync(cwd, { recursive: true, force: true }) })

it('gives invitations a stable operation ID and never categorizes sending as a read', () => {
  const parsed = parseDatabaseOptions('auth-invite', options)
  expect(parsed).toEqual({ ...options, operationId: expect.any(String) })
  expect(parseDatabaseOptions('auth-invite', parsed)).toEqual(parsed)
  expect(isDatabaseReadCommand('supremo auth invite --environment development --email person@example.test')).toBe(false)
  expect(() => parseDatabaseOptions('auth-invite', { ...options, password: 'private-value' })).toThrow()
})
it('retains a maximum-length invitation recipient in the durable request', () => {
  const email = `${'a'.repeat(64)}@${['b'.repeat(63), 'c'.repeat(63), 'd'.repeat(63), 'e'.repeat(59), 'com'].join('.')}`
  const parsed = parseDatabaseOptions('auth-invite', { ...options, email })
  const cwd = workspace(), id = enqueueDatabaseOperation(cwd, 'auth-invite', parsed)
  expect(readDurableOperation(cwd, id)).toMatchObject({ options: { email } })
  expect(() => parseDatabaseOptions('auth-invite', { ...options, email: `a${email}` })).toThrow()
})
it.each(['lost-response', 'uncertain-receipt'] as const)('never repeats an invitation after %s', async outcome => {
  const cwd = workspace(), parsed = parseDatabaseOptions('auth-invite', options)
  const id = enqueueDatabaseOperation(cwd, 'auth-invite', parsed)
  const execute = vi.fn(async () => {
    if (outcome === 'lost-response') throw new Error('response lost after provider accepted')
    return { receipt: { id: parsed.operationId, state: 'uncertain', result: null } }
  })
  await drainDurableOperations(cwd, execute)
  await drainDurableOperations(cwd, execute)
  expect(readDurableOperation(cwd, id)).toMatchObject({ status: 'uncertain' })
  expect(() => resumeDatabaseOperation(cwd, id)).toThrow('Somente recusa')
  expect(execute).toHaveBeenCalledOnce()
})
it('uploads only invitation metadata and the server-bound target through the daemon', async () => {
  const cwd = workspace(), parsed = parseDatabaseOptions('auth-invite', options)
  const fetcher = vi.fn(async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { operation: string }
    return Response.json(body.operation === 'status' ? { projectRef: 'owned-ref', environment: 'development', automaticMigrations: true }
      : { projectId, projectRef: 'owned-ref', environment: 'development', operation: 'auth-invite', data: { invitationAccepted: true } })
  })
  vi.stubGlobal('fetch', fetcher)
  await runDatabaseDirect('auth-invite', cwd, parsed)
  expect(fetcher).toHaveBeenLastCalledWith(new URL(`${issuer}/api/database`), expect.objectContaining({ method: 'POST', redirect: 'error',
    body: JSON.stringify({ deviceSecret: 'fixture-device-value', projectId, operation: 'auth-invite', expectedRef: 'owned-ref', environment: 'development', operationId: parsed.operationId, email: options.email, redirectTo: options.redirectTo }),
  }))
})
