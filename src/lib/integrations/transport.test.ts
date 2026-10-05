import { EventEmitter } from 'node:events'
import type { ClientRequest, IncomingMessage } from 'node:http'
import type { RequestOptions } from 'node:https'
import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ dns: vi.fn(), cancel: vi.fn(), request: vi.fn() }))
vi.mock('node:dns/promises', () => ({ Resolver: class { resolve4 = mocks.dns; cancel = mocks.cancel } }))
vi.mock('node:https', () => ({ request: mocks.request }))
import { protectedJsonRequest, protectedProviderRequest } from './transport'
const input = { origin: 'https://api.example.com', method: 'POST' as const, path: '/v1/test', authorization: { kind: 'bearer' as const, value: 'fixture-private-credential' }, body: '{}' }
let status: number, body: string, captured: RequestOptions, mode: 'normal' | 'error' | 'interrupted'
class FakeRequest extends EventEmitter {
  setTimeout() { return this }
  destroy() { this.emit('error', new Error('private provider detail')); return this }
  end() {
    if (mode === 'error') { queueMicrotask(() => this.emit('error', new Error('private provider detail'))); return this }
    return this
  }
}
beforeEach(() => {
  vi.resetAllMocks(); status = 200; body = '{"id":"safe-id"}'; mode = 'normal'
  mocks.dns.mockResolvedValue(['8.8.8.8'])
  mocks.request.mockImplementation((options: RequestOptions, listener: (response: IncomingMessage) => void) => {
    captured = options
    const incoming = Object.assign(new EventEmitter(), { statusCode: status, resume: vi.fn(), destroy: vi.fn() })
    const outgoing = new FakeRequest()
    queueMicrotask(() => {
      if (mode === 'error') return
      listener(incoming as unknown as IncomingMessage)
      if (mode === 'interrupted') incoming.emit('error', new Error('private response'))
      else { incoming.emit('data', Buffer.from(body)); incoming.emit('end') }
    })
    return outgoing as unknown as ClientRequest
  })
})
describe('pinned HTTPS connector transport', () => {
  it('pins the validated DNS address into TLS lookup and injects only permitted headers', async () => {
    expect(await protectedJsonRequest(input)).toEqual({ id: 'safe-id' })
    expect(captured.hostname).toBe('api.example.com'); expect(captured.servername).toBe('api.example.com'); expect(captured.port).toBe(443)
    expect(captured.headers).toMatchObject({ Authorization: 'Bearer fixture-private-credential', 'Content-Type': 'application/json' })
    expect(captured.signal).toBeInstanceOf(AbortSignal)
    const callback = vi.fn()
    captured.lookup!('ignored-after-validation.example.com', { family: 4 }, callback)
    expect(callback).toHaveBeenCalledWith(null, '8.8.8.8', 4)
    expect(mocks.dns).toHaveBeenCalledOnce(); expect(mocks.cancel).toHaveBeenCalledOnce()
  })
  it('rejects mixed private DNS answers before sending any credential', async () => {
    mocks.dns.mockResolvedValueOnce(['8.8.8.8', '169.254.169.254'])
    await expect(protectedJsonRequest(input)).rejects.toThrow('não permitido')
    expect(mocks.request).not.toHaveBeenCalled()
    mocks.dns.mockRejectedValueOnce(new Error('DNS private details'))
    await expect(protectedJsonRequest(input)).rejects.toThrow('resolver')
  })
  it.each([301, 302, 307, 400, 429, 500])('does not follow response %i or return provider error content', async code => {
    status = code; body = 'private-provider-error'
    const error: unknown = await protectedJsonRequest(input).catch((value: unknown) => value)
    expect(error).toMatchObject({ httpStatus: code, code: code === 429 ? 'rate_limited' : code >= 500 ? 'outcome_unknown' : 'unavailable' })
    expect(String(error)).not.toContain(body); expect(mocks.request).toHaveBeenCalledOnce()
  })
  it.each(['invalid-json', 'oversized', 'interrupted', 'error'] as const)('reports %s without raw response/exception', async failure => {
    if (failure === 'invalid-json') body = 'private-malformed-response'
    else if (failure === 'oversized') body = 'x'.repeat(128001)
    else mode = failure
    await expect(protectedJsonRequest(input)).rejects.toMatchObject({ code: 'outcome_unknown' })
  })
  it('accepts OAuth form authentication and catalog-specific content type but forbids unsafe paths', async () => {
    await protectedJsonRequest({ ...input, authorization: { kind: 'basic', value: 'encoded-private' }, contentType: 'application/x-www-form-urlencoded' })
    expect(captured.headers).toMatchObject({ Authorization: 'Basic encoded-private', 'Content-Type': 'application/x-www-form-urlencoded' })
    await protectedJsonRequest({ ...input, authorization: { kind: 'x-api-key', value: 'private-api-key' } })
    expect(captured.headers).toMatchObject({ 'X-API-Key': 'private-api-key' })
    await protectedProviderRequest({ provider: 'stripe-test', method: 'POST', path: '/v1/products', credential: 'sk_test_fixture', idempotencyKey: 'same-request', body: 'name=test' })
    expect(captured.headers).toMatchObject({ 'Idempotency-Key': 'same-request', 'Content-Type': 'application/x-www-form-urlencoded' })
    for (const path of ['/../admin', '//elsewhere', '/token?secret=private', 'https://evil.com']) await expect(protectedJsonRequest({ ...input, path })).rejects.toThrow()
  })
})
