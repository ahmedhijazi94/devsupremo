import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHmac } from 'node:crypto'
import { supabaseFunctionProvider } from './provider'
import { FunctionError, hookSecretDigest } from './policy'
import { runFunctions } from './service'
const secret = `v1,whsec_${Buffer.alloc(32, 2).toString('base64')}`
const ref = 'dev-ref'
const token = 'private-management-token'
beforeEach(() => vi.stubGlobal('fetch', vi.fn(async () => Response.json({}))))
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })
describe('Supabase function Management API transport', () => {
  it('configures the hook through real-format GET secrets responses and confirms them after the write', async () => {
    const uri = `https://${ref}.supabase.co/functions/v1/send-email`
    let config = { hook_send_email_enabled: false, hook_send_email_uri: uri, hook_send_email_secrets: secret, external_email_enabled: true }
    const unrelated = { name: 'RESEND_API_KEY', value: hookSecretDigest('private-resend-fixture'), updated_at: '2026-09-26T12:00:00Z' }
    let metadata = [unrelated]
    const resolve = vi.fn(async () => ({ projectRef: ref, token }))
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input)
      if (url.endsWith('/config/auth')) {
        if (init?.method === 'PATCH') config = { ...config, ...JSON.parse(String(init.body)) }
        return Response.json(config)
      }
      if (url.endsWith('/secrets')) {
        if (init?.method === 'POST') {
          const posted = JSON.parse(String(init.body)) as { name: string; value: string }[]
          expect(posted).toEqual([{ name: 'AUTH_SEND_EMAIL_HOOK_SECRET', value: secret }])
          metadata = [...metadata, { name: posted[0]!.name, value: hookSecretDigest(posted[0]!.value), updated_at: '2026-09-26T12:01:00Z' }]
          return new Response(null, { status: 201 })
        }
        return Response.json(metadata)
      }
      if (url === uri) {
        const headers = init?.headers as Record<string, string>
        if (!headers['webhook-signature']) return new Response(null, { status: 401 })
        const timestamp = Number(headers['webhook-timestamp'])
        const signature = `v1,${createHmac('sha256', Buffer.alloc(32, 2)).update(`${headers['webhook-id']}.${timestamp}.${init?.body}`).digest('base64')}`
        return new Response(null, { status: Math.abs(Date.now() / 1000 - timestamp) < 300 && headers['webhook-signature'] === signature ? 400 : 401 })
      }
      if (url.endsWith('/functions/send-email')) return Response.json({ id: 'function-fixture', slug: 'send-email', status: 'ACTIVE', version: 2, verify_jwt: false })
      throw new Error('Unexpected fixture endpoint')
    })
    vi.stubGlobal('fetch', fetcher)
    const result = await runFunctions(supabaseFunctionProvider(resolve), { operation: 'functions-hook-configure', environment: 'development', slug: 'send-email', secretName: 'AUTH_SEND_EMAIL_HOOK_SECRET' },
      { ownerId: 'owner-fixture', projectId: 'project-fixture', projectRef: ref, environment: 'development' })
    expect(result).toMatchObject({ verified: true, signatureVerified: true, deliveryVerified: false })
    expect(resolve).toHaveBeenCalledTimes(fetcher.mock.calls.length + 1) // configureHook also validates the fresh target before dispatch.
    expect(fetcher.mock.calls.filter(([url, init]) => String(url).endsWith('/secrets') && init?.method === 'GET')).toHaveLength(2)
    expect(metadata).toContainEqual(unrelated)
    expect(JSON.stringify(result)).not.toContain(secret)
    expect(JSON.stringify(result)).not.toContain(unrelated.value)
  })
  it('accepts the documented empty 201 for secret creation without relaxing JSON requirements for reads', async () => {
    const p = supabaseFunctionProvider(async () => ({ projectRef: ref, token }))
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 201 }))
    await expect(p.setSecret('AUTH_SEND_EMAIL_HOOK_SECRET', secret)).resolves.toBeUndefined()
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 200 }))
    await expect(p.secrets()).rejects.toThrow('Resposta do Supabase')
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 201 }))
    await expect(p.authConfig()).rejects.toThrow('Resposta do Supabase')
  })
  it('sends repeated file parts with complete project-relative names and matching metadata', async () => {
    const resolve = vi.fn(async () => ({ projectRef: ref, token }))
    const provider = supabaseFunctionProvider(resolve)
    const files = [{ path: 'supabase/functions/send-email/index.js', content: 'import "../../../src/auth.ts"' }, { path: 'src/auth.ts', content: 'export const ready = true' },
      { path: 'supabase/functions/send-email/deno.json', content: '{"imports":{"zod":"npm:zod@4.5.4"}}' }]
    await provider.deploy({ slug: 'send-email', environment: 'development', entrypoint: files[0]!.path, importMap: files[2]!.path, files, verifyJwt: false })
    const [url, init] = vi.mocked(fetch).mock.calls[0]!
    expect(url).toBe(`https://api.supabase.com/v1/projects/${ref}/functions/deploy?slug=send-email`)
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', cache: 'no-store', headers: { Authorization: `Bearer ${token}` } })
    expect(init?.headers).not.toHaveProperty('Content-Type')
    const form = init?.body as FormData
    expect(JSON.parse(String(form.get('metadata')))).toEqual({ name: 'send-email', entrypoint_path: files[0]!.path, import_map_path: files[2]!.path, verify_jwt: false, static_patterns: [] })
    const posted = form.getAll('file') as File[]
    expect(posted.map(file => file.name)).toEqual(files.map(file => file.path))
    expect(await Promise.all(posted.map(file => file.text()))).toEqual(files.map(file => file.content))
    expect(resolve).toHaveBeenCalledOnce()
  })
  it('uses empty import map when absent and never accepts invalid bundle source paths', async () => {
    const p = supabaseFunctionProvider(async () => ({ projectRef: ref, token }))
    const file = { path: 'supabase/functions/hello/index.ts', content: 'export {}' }
    await p.deploy({ slug: 'hello', environment: 'production', entrypoint: file.path, files: [file], verifyJwt: true })
    expect(JSON.parse(String((vi.mocked(fetch).mock.calls[0]![1]!.body as FormData).get('metadata'))).import_map_path).toBe('')
    await expect(p.deploy({ slug: 'hello', environment: 'development', entrypoint: '../secrets.ts', files: [file], verifyJwt: true })).rejects.toThrow()
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('resolves fresh authority for every request and propagates revocation before networking', async () => {
    const resolve = vi.fn(async () => ({ projectRef: ref, token }))
    const p = supabaseFunctionProvider(resolve)
    await p.list(); await p.authConfig(); await p.secrets()
    expect(resolve).toHaveBeenCalledTimes(3)
    resolve.mockRejectedValueOnce(new FunctionError('Dispositivo revogado.', 401))
    await expect(p.get('send-email')).rejects.toMatchObject({ status: 401 })
    expect(fetch).toHaveBeenCalledTimes(3)
  })
  it('treats404 only as missing function,204 as empty success, and never exposes provider errors', async () => {
    const p = supabaseFunctionProvider(async () => ({ projectRef: ref, token }))
    vi.mocked(fetch).mockResolvedValueOnce(new Response('private-error', { status: 404 }))
    expect(await p.get('missing')).toBeNull()
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 204 }))
    await expect(p.setSecret('AUTH_SEND_EMAIL_HOOK_SECRET', secret)).resolves.toBeUndefined()
    for (const status of [401, 403, 404, 429, 500]) {
      vi.mocked(fetch).mockResolvedValueOnce(new Response('private-provider-error', { status }))
      const err = await p.list().catch(error => error as Error)
      expect(err).toMatchObject({ status: [401, 403].includes(status) ? status : 502 })
      expect(String(err)).not.toContain('private-provider-error')
    }
  })
  it('fails closed on transport, malformed, oversized and timed-out responses without provider values', async () => {
    const p = supabaseFunctionProvider(async () => ({ projectRef: ref, token }))
    vi.mocked(fetch).mockRejectedValueOnce(new Error('private-network-token'))
    await expect(p.list()).rejects.toThrow('não confirmou')
    vi.mocked(fetch).mockResolvedValueOnce(new Response('private-invalid-json'))
    await expect(p.list()).rejects.toThrow('Resposta')
    vi.mocked(fetch).mockResolvedValueOnce(new Response('x', { headers: { 'content-length': '512001' } }))
    await expect(p.list()).rejects.toThrow('Resposta')
    const started = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(started + 56_000)
    await expect(p.list()).rejects.toThrow('não confirmou')
  })
  it('patches only its exact own-ref hook target and a valid private signing value', async () => {
    const p = supabaseFunctionProvider(async () => ({ projectRef: ref, token }))
    await p.configureHook(`https://${ref}.supabase.co/functions/v1/send-email`, secret)
    expect(vi.mocked(fetch).mock.calls[0]).toEqual([`https://api.supabase.com/v1/projects/${ref}/config/auth`, expect.objectContaining({ method: 'PATCH',
      body: JSON.stringify({ hook_send_email_enabled: true, hook_send_email_uri: `https://${ref}.supabase.co/functions/v1/send-email`, hook_send_email_secrets: secret }) })])
    for (const uri of ['https://other-ref.supabase.co/functions/v1/send-email', `https://${ref}.supabase.co/functions/v1/send-email?key=x`, `https://${ref}.supabase.co/functions/v1/send-email#x`])
      await expect(p.configureHook(uri, secret)).rejects.toThrow('Destino')
    await expect(p.configureHook(`https://${ref}.supabase.co/functions/v1/send-email`, 'invalid')).rejects.toThrow()
    await expect(p.setSecret('SUPABASE_AUTH_HOOK_SECRET', secret)).rejects.toThrow()
    await expect(p.setSecret('AUTH_SEND_EMAIL_HOOK_SECRET', 'invalid')).rejects.toThrow()
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('probes only fixed empty payloads and signs them without any admin bearer, recipient or OTP', async () => {
    const p = supabaseFunctionProvider(async () => ({ projectRef: ref, token }))
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 401 }))
    expect(await p.probe('send-email')).toBe(401)
    expect(vi.mocked(fetch).mock.calls[0]![1]?.headers).toEqual({ 'Content-Type': 'application/json' })
    for (const mode of ['valid', 'invalid', 'expired'] as const) {
      vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: mode === 'valid' ? 400 : 401 }))
      expect(await p.probe('send-email', secret, mode)).toBe(mode === 'valid' ? 400 : 401)
      const [url, init] = vi.mocked(fetch).mock.calls.at(-1)!
      expect(url).toBe(`https://${ref}.supabase.co/functions/v1/send-email`)
      const headers = init?.headers as Record<string, string>
      expect(headers.Authorization).toBeUndefined()
      expect(init?.body).toBe('{}')
      const signed = `${headers['webhook-id']}.${headers['webhook-timestamp']}.${mode === 'invalid' ? '{"tampered":true}' : '{}'}`
      expect(headers['webhook-signature']).toBe(`v1,${createHmac('sha256', Buffer.alloc(32, 2)).update(signed).digest('base64')}`)
      expect(Math.floor(Date.now() / 1000) - Number(headers['webhook-timestamp'])).toBeGreaterThanOrEqual(mode === 'expired' ? 600 : 0)
    }
    vi.mocked(fetch).mockRejectedValueOnce(new Error('private-network-token'))
    await expect(p.probe('send-email', secret)).rejects.toThrow('Não foi possível')
  })
})
