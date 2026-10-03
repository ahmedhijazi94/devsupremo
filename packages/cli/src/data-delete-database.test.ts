import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runDatabaseDirect } from './database'

const projectId = '11111111-1111-4111-8111-111111111111'
const planId = '22222222-2222-4222-8222-222222222222'
const planToken = 'signed-plan-fixture-'.repeat(5)
const issuer = 'https://supremo.example.invalid'
const targets = [{ table: 'orgs', key: { id: 'requested-company' } }]
vi.mock('./daemon', () => ({ readProjectConfig: () => ({ projectId, apiBaseUrl: issuer }) }))
vi.mock('./keychain', () => ({ resolveKeychain: () => ({ get: () => JSON.stringify({ version: 1, projectId, issuer, secret: 'fixture-device-authorization' }) }) }))
let cwd: string, environment: string, calls: Record<string, unknown>[], responsePatch: Record<string, unknown>
let failure: 'http' | 'timeout' | undefined
beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'supremo-delete-database-'))
  fs.mkdirSync(path.join(cwd, '.supremo'))
  fs.mkdirSync(path.join(cwd, 'supabase/.temp'), { recursive: true })
  fs.writeFileSync(path.join(cwd, 'supabase/.temp/project-ref'), 'owned-ref')
  fs.writeFileSync(path.join(cwd, '.env.local'), 'NEXT_PUBLIC_SUPABASE_URL=https://owned-ref.supabase.co\n')
  calls = []; environment = 'development'; responsePatch = {}; failure = undefined
  vi.stubGlobal('fetch', vi.fn(async (url: URL, init: RequestInit) => {
    expect(url.toString()).toBe(`${issuer}/api/database`)
    expect(init.redirect).toBe('error')
    const input = JSON.parse(String(init.body)) as Record<string, unknown>
    calls.push(input)
    if (input.operation === 'status') return Response.json({ environment, projectRef: 'owned-ref', automaticMigrations: environment === 'development' })
    if (failure === 'http') return Response.json({ error: 'Plano expirado ou já utilizado.' }, { status: 409 })
    if (failure === 'timeout') throw new Error('Tempo excedido')
    return Response.json({ projectId, projectRef: 'owned-ref', environment, operation: input.operation,
      readOnly: input.operation === 'data-delete-plan', observedAt: new Date().toISOString(),
      data: input.operation === 'data-delete-plan' ? { planId, planToken, expiresAt: new Date(Date.now() + 60_000).toISOString(), targets, impactCount: 1 }
        : { planId, deletedCount: 1, verified: true }, ...responsePatch })
  }))
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); fs.rmSync(cwd, { recursive: true, force: true }) })
const apply = () => runDatabaseDirect('data-delete-apply', cwd, { environment: 'development', planToken, authorization: 'Usuário pediu excluir a empresa identificada.' })

describe('deletion transport remains bound to the authorized development project', () => {
  it('fetches fresh status and validates the local link before planning', async () => {
    expect(await runDatabaseDirect('data-delete-plan', cwd, { environment: 'development', targets })).toMatchObject({ readOnly: true, data: { impactCount: 1 } })
    expect(calls.map(call => call.operation)).toEqual(['status', 'data-delete-plan'])
    expect(calls[1]).toMatchObject({ projectId, expectedRef: 'owned-ref', environment: 'development', targets })
  })
  it('applies the signed plan once through the daemon backend without reading migration files or running tests', async () => {
    expect(await apply()).toMatchObject({ readOnly: false, data: { deletedCount: 1, verified: true } })
    expect(calls.map(call => call.operation)).toEqual(['status', 'data-delete-apply'])
    expect(calls[1]).toMatchObject({ expectedRef: 'owned-ref', planToken, authorization: 'Usuário pediu excluir a empresa identificada.' })
    expect(fs.existsSync(path.join(cwd, 'supabase/migrations'))).toBe(false)
  })
  it.each(['production', 'unknown'])('refuses %s before sending a delete request', async target => {
    environment = target
    await expect(apply()).rejects.toThrow('protegidos')
    expect(calls.map(call => call.operation)).toEqual(['status'])
  })
  it('refuses a mismatched preview bank before sending the request', async () => {
    fs.writeFileSync(path.join(cwd, '.env.local'), 'NEXT_PUBLIC_SUPABASE_URL=https://foreign.supabase.co\n')
    await expect(apply()).rejects.toThrow('diverge')
    expect(calls.map(call => call.operation)).toEqual(['status'])
  })
  it.each([
    { projectId: '33333333-3333-4333-8333-333333333333' }, { projectRef: 'foreign' },
    { operation: 'data-delete-plan' }, { readOnly: true }, { environment: 'production' },
    { data: { planId, deletedCount: 1, verified: false } },
  ])('does not announce success for a mismatched response: %j', async patch => {
    responsePatch = patch
    await expect(apply()).rejects.toThrow('não corresponde')
    expect(calls.map(call => call.operation)).toEqual(['status', 'data-delete-apply'])
  })
  it.each(['http', 'timeout'] as const)('never retries a mutation after %s failure', async type => {
    failure = type
    await expect(apply()).rejects.toThrow()
    expect(calls.map(call => call.operation)).toEqual(['status', 'data-delete-apply'])
  })
  it('preserves the fixed server diagnostic for a rejected plan', async () => {
    failure = 'http'
    await expect(apply()).rejects.toThrow('Plano expirado ou já utilizado.')
    expect(calls.map(call => call.operation)).toEqual(['status', 'data-delete-apply'])
  })
  it.each(['network', 'body', 'json'])('requires reconciliation after an uncertain %s failure without exposing raw errors or retrying', async stage => {
    const original = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation((url, init) => {
      if (JSON.parse(String(init?.body)).operation === 'data-delete-apply') {
        calls.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
        if (stage === 'network') return Promise.reject(new Error('raw private network detail'))
        const response = new Response('raw private malformed response')
        if (stage === 'body') vi.spyOn(response, 'text').mockRejectedValue(new Error('raw private body detail'))
        return Promise.resolve(response)
      }
      return original(url, init)
    })
    const error = await apply().catch((value: unknown) => value)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('Não repita delete-apply')
    expect((error as Error).message).toContain('db query')
    expect((error as Error).message).not.toContain('raw private')
    expect(calls.map(call => call.operation)).toEqual(['status', 'data-delete-apply'])
  })
  it.each(['request', 'body'])('releases the worker when the provider ignores cancellation in the %s', async stage => {
    vi.useFakeTimers()
    const original = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation((url, init) => {
      if (JSON.parse(String(init?.body)).operation === 'data-delete-apply') {
        calls.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
        if (stage === 'body') {
          const response = Response.json({})
          vi.spyOn(response, 'text').mockImplementation(() => new Promise<string>(() => undefined))
          return Promise.resolve(response)
        }
        return new Promise<Response>(() => undefined)
      }
      return original(url, init)
    })
    const pending = apply().catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(60_000)
    expect((await pending as Error).message).toContain('Não repita delete-apply')
    expect(calls.map(call => call.operation)).toEqual(['status', 'data-delete-apply'])
  })
  it('never starts a deletion when the fresh status request hangs', async () => {
    vi.useFakeTimers()
    vi.mocked(fetch).mockImplementation(() => new Promise<Response>(() => undefined))
    const pending = apply().catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(15_000)
    expect((await pending as Error).message).toContain('nenhum pedido de exclusão foi enviado')
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
