import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runFunctions } from './service'
import { deriveHookSecret, hookSecretDigest } from './policy'
import type { FunctionProvider } from './provider'
import { FUNCTION_HOOK_SECRET_NAME, type FunctionOptions } from './contract'

const context = { ownerId: '00000000-0000-4000-8000-000000000001', projectId: '00000000-0000-4000-8000-000000000002', projectRef: 'dev-ref', environment: 'development' as const }
const functionRecord = { id: 'function-id', slug: 'send-email', status: 'ACTIVE', version: 2, verify_jwt: false, private_token: 'provider-private' }
const uri = 'https://dev-ref.supabase.co/functions/v1/send-email'
const options = { operation: 'functions-hook-configure', environment: 'development', slug: 'send-email', secretName: FUNCTION_HOOK_SECRET_NAME } as const
const disabled = { hook_send_email_enabled: false, hook_send_email_uri: '', hook_send_email_secrets: '', external_email_enabled: true }
let config: typeof disabled
let installed: { name: string; value: string; updated_at?: string }[]
function fixture() {
  const provider = {
    list: vi.fn(async () => [functionRecord]), get: vi.fn(async () => ({ ...functionRecord })), deploy: vi.fn<FunctionProvider['deploy']>(async () => ({ ...functionRecord })),
    authConfig: vi.fn(async () => ({ ...config })), secrets: vi.fn(async () => [...installed]),
    configureHook: vi.fn(async (target: string, secret: string) => { config = { ...config, hook_send_email_enabled: true, hook_send_email_uri: target, hook_send_email_secrets: secret } }),
    setSecret: vi.fn(async (name: string, secret: string) => { installed = [...installed.filter(row => row.name !== name), { name, value: hookSecretDigest(secret), updated_at: '2026-09-26T12:00:00Z' }] }),
    probe: vi.fn<FunctionProvider['probe']>(async (_slug, secret, validity) => secret && (!validity || validity === 'valid') ? 400 : 401),
  } satisfies FunctionProvider
  return provider
}
beforeEach(() => { config = { ...disabled }; installed = []; vi.stubEnv('ENCRYPTION_KEY', 'a'.repeat(64)) })
afterEach(() => vi.unstubAllEnvs())
describe('Edge Function metadata and confirmed deployment', () => {
  it('lists/statuses only fixed metadata, supports missing function and absent JWT metadata', async () => {
    const p = fixture()
    const list = await runFunctions(p, { operation: 'functions-list', environment: 'development' }, context)
    expect(list).toEqual({ functions: [{ slug: 'send-email', status: 'ACTIVE', version: 2, verifyJwt: false }] })
    expect(JSON.stringify(list)).not.toContain('provider-private')
    expect(await runFunctions(p, { operation: 'functions-status', environment: 'development', slug: 'send-email' }, context)).toEqual({ function: { slug: 'send-email', status: 'ACTIVE', version: 2, verifyJwt: false } })
    p.get.mockResolvedValueOnce(null as never)
    expect(await runFunctions(p, { operation: 'functions-status', environment: 'development', slug: 'send-email' }, context)).toEqual({ function: null })
    p.list.mockResolvedValueOnce([{ ...functionRecord, verify_jwt: undefined }] as never)
    expect(await runFunctions(p, { operation: 'functions-list', environment: 'development' }, context)).toMatchObject({ functions: [{ verifyJwt: null }] })
  })
  it('rejects malformed provider list/status and slug substitution', async () => {
    const p = fixture()
    p.list.mockResolvedValueOnce('token=provider-secret' as never)
    await expect(runFunctions(p, { operation: 'functions-list', environment: 'development' }, context)).rejects.toThrow('Lista')
    p.get.mockResolvedValueOnce({ ...functionRecord, slug: 'another' })
    await expect(runFunctions(p, { operation: 'functions-status', environment: 'development', slug: 'send-email' }, context)).rejects.toThrow('Metadados')
  })
  const deploy: FunctionOptions = { operation: 'functions-deploy', environment: 'development', slug: 'send-email',
    entrypoint: 'supabase/functions/send-email/index.js', files: [{ path: 'supabase/functions/send-email/index.js', content: 'Deno.serve(handler)' }], verifyJwt: false }
  it('reads the published version again before declaring deployment verified, never delivery', async () => {
    const p = fixture()
    expect(await runFunctions(p, deploy, context)).toMatchObject({ deployed: true, verified: true, deliveryVerified: false })
    expect(p.get).toHaveBeenCalledWith('send-email')
    expect(p.deploy.mock.calls[0]![0]).not.toHaveProperty('operation')
  })
  it.each([{ id: 'other-id' }, { version: 3 }, { status: 'THROTTLED' }, { verify_jwt: true }])('rejects changed deployment metadata %j', patch => {
    const p = fixture()
    p.get.mockResolvedValueOnce({ ...functionRecord, ...patch })
    return expect(runFunctions(p, deploy, context)).rejects.toThrow('não foi confirmada')
  })
})
describe('signed email hook orchestration', () => {
  it('installs a private server-generated key, verifies all signature checks and enables only its own URL', async () => {
    const p = fixture()
    const result = await runFunctions(p, options, context)
    const secret = deriveHookSecret({ ...context, slug: options.slug, secretName: FUNCTION_HOOK_SECRET_NAME })
    expect(p.setSecret).toHaveBeenCalledWith(FUNCTION_HOOK_SECRET_NAME, secret)
    expect(p.configureHook).toHaveBeenCalledWith(uri, secret)
    expect(p.probe.mock.calls).toEqual([['send-email'], ['send-email', secret, 'invalid'], ['send-email', secret, 'expired'], ['send-email', secret]])
    expect(result).toEqual({ hook: { enabled: true, targetSlug: 'send-email', targetMatchesProject: true, signingSecretConfigured: true }, configured: true, verified: true, signatureVerified: true, deliveryVerified: false })
    expect(JSON.stringify(result)).not.toContain(secret)
  })
  it('makes retries idempotent and retains a valid existing server-only signing key', async () => {
    const secret = `v1,whsec_${Buffer.alloc(32, 7).toString('base64')}`
    config = { ...config, hook_send_email_enabled: true, hook_send_email_uri: uri, hook_send_email_secrets: secret }
    installed = [{ name: FUNCTION_HOOK_SECRET_NAME, value: hookSecretDigest(secret) }]
    const p = fixture()
    await runFunctions(p, options, context)
    expect(p.setSecret).not.toHaveBeenCalled()
    expect(p.configureHook).not.toHaveBeenCalled()
    expect(p.probe).toHaveBeenLastCalledWith('send-email', secret)
  })
  it('repairs a missing private env value using the same existing key', async () => {
    const secret = `v1,whsec_${Buffer.alloc(32, 9).toString('base64')}`
    config = { ...config, hook_send_email_enabled: true, hook_send_email_uri: uri, hook_send_email_secrets: secret }
    const p = fixture()
    await runFunctions(p, options, context)
    expect(p.setSecret).toHaveBeenCalledWith(FUNCTION_HOOK_SECRET_NAME, secret)
    expect(p.configureHook).not.toHaveBeenCalled()
  })
  it('preserves unrelated real API secrets and verifies the newly installed fingerprint on read-back', async () => {
    const unrelated = { name: 'RESEND_API_KEY', value: hookSecretDigest('unrelated-private-fixture'), updated_at: '2026-09-26T12:00:00Z' }
    installed = [unrelated]
    const p = fixture()
    const result = await runFunctions(p, options, context)
    expect(result).toMatchObject({ verified: true, deliveryVerified: false })
    expect(installed).toContainEqual(unrelated)
    expect(p.secrets).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(result)).not.toContain(unrelated.value)
  })
  it('refuses a different reserved fingerprint instead of overwriting the existing secret', async () => {
    installed = [{ name: FUNCTION_HOOK_SECRET_NAME, value: hookSecretDigest('another-private-fixture') }]
    const p = fixture()
    await expect(runFunctions(p, options, context)).rejects.toThrow('Nenhuma credencial foi sobrescrita')
    expect(p.setSecret).not.toHaveBeenCalled()
    expect(p.configureHook).not.toHaveBeenCalled()
    expect(p.probe).not.toHaveBeenCalled()
  })
  it.each(['duplicate', 'conflicting-alias', 'plaintext', 'missing-value'] as const)('refuses %s metadata before mutating the provider', async kind => {
    const p = fixture()
    const row = { name: FUNCTION_HOOK_SECRET_NAME, value: hookSecretDigest('fixture') }
    const raw = kind === 'duplicate' ? [row, row] : kind === 'conflicting-alias' ? [{ ...row, digest: 'f'.repeat(64) }]
      : kind === 'plaintext' ? [{ ...row, value: 'private-never' }] : [{ name: row.name, digest: row.value }]
    p.secrets.mockResolvedValueOnce(raw as never)
    const error: unknown = await runFunctions(p, options, context).catch((reason: unknown) => reason)
    expect(error).toMatchObject({ status: 502, message: 'Metadados dos segredos da função não confirmados.' })
    expect(String(error)).not.toContain('private-never')
    expect(p.setSecret).not.toHaveBeenCalled()
    expect(p.configureHook).not.toHaveBeenCalled()
    expect(p.probe).not.toHaveBeenCalled()
  })
  it('does not reuse a key without a binding to this function', async () => {
    config = { ...config, hook_send_email_secrets: `v1,whsec_${Buffer.alloc(32, 8).toString('base64')}` }
    const p = fixture()
    await expect(runFunctions(p, options, context)).rejects.toThrow('não está vinculada')
    expect(p.setSecret).not.toHaveBeenCalled(); expect(p.configureHook).not.toHaveBeenCalled()
  })
  it.each([{ hook_send_email_uri: 'https://foreign.test/hook' }, { external_email_enabled: false }, { hook_send_email_secrets: '***' }])('refuses incompatible setup without provider writes %j', patch => {
    config = { ...config, ...patch }
    const p = fixture()
    return expect(runFunctions(p, options, context)).rejects.toThrow().then(() => {
      expect(p.setSecret).not.toHaveBeenCalled(); expect(p.configureHook).not.toHaveBeenCalled()
    })
  })
  it.each([{ verify_jwt: true }, { verify_jwt: undefined }, { status: 'REMOVED' }])('requires deployed active signature-capable function %j', patch => {
    const p = fixture()
    p.get.mockResolvedValueOnce({ ...functionRecord, ...patch } as never)
    return expect(runFunctions(p, options, context)).rejects.toThrow('função ativa')
  })
  it.each([0, 1, 2, 3])('blocks enabling when signature probe %i fails', async index => {
    const p = fixture()
    for (let i = 0; i < index; i++) p.probe.mockResolvedValueOnce(401)
    p.probe.mockResolvedValueOnce(503)
    await expect(runFunctions(p, options, context)).rejects.toThrow('assinatura')
    expect(p.configureHook).not.toHaveBeenCalled()
  })
  it('refuses config changes before installing any key', async () => {
    const p = fixture()
    p.authConfig.mockResolvedValueOnce({ ...config }).mockResolvedValueOnce({ ...config, hook_send_email_enabled: true })
    await expect(runFunctions(p, options, context)).rejects.toThrow('mudou')
    expect(p.setSecret).not.toHaveBeenCalled()
  })
  it('refuses changed keys after probes and leaves concurrent configuration alone', async () => {
    const p = fixture()
    p.probe.mockImplementation(async (_slug, secret, validity) => {
      config = { ...config, hook_send_email_secrets: 'concurrently-updated' }
      return secret && !validity ? 400 : 401
    })
    await expect(runFunctions(p, options, context)).rejects.toThrow('mudou')
    expect(p.configureHook).not.toHaveBeenCalled()
  })
  it('allows concurrent identical setup to converge without a second auth patch', async () => {
    const p = fixture()
    p.probe.mockImplementation(async (_slug, secret, validity) => {
      if (secret && !validity) config = { ...config, hook_send_email_enabled: true, hook_send_email_uri: uri, hook_send_email_secrets: secret }
      return secret && !validity ? 400 : 401
    })
    await expect(runFunctions(p, options, context)).resolves.toMatchObject({ verified: true })
    expect(p.configureHook).not.toHaveBeenCalled()
  })
  it.each(['auth', 'digest', 'function', 'missing-secret'])('does not certify changed final %s readback', async field => {
    const p = fixture()
    p.configureHook.mockImplementation(async (target, secret) => {
      config = { ...config, hook_send_email_enabled: true, hook_send_email_uri: target, hook_send_email_secrets: field === 'auth' ? 'changed' : secret }
      if (field === 'digest') installed = [{ name: FUNCTION_HOOK_SECRET_NAME, value: hookSecretDigest('changed') }]
      if (field === 'missing-secret') installed = []
      if (field === 'function') p.get.mockResolvedValue({ ...functionRecord, version: 5 })
    })
    await expect(runFunctions(p, options, context)).rejects.toThrow('resultado final')
  })
  it('refuses duplicate final metadata even after the signature challenge succeeds', async () => {
    const p = fixture()
    p.configureHook.mockImplementation(async (target, secret) => {
      config = { ...config, hook_send_email_enabled: true, hook_send_email_uri: target, hook_send_email_secrets: secret }
      installed.push({ ...installed[0]! })
    })
    await expect(runFunctions(p, options, context)).rejects.toThrow('Metadados')
    expect(p.probe).toHaveBeenCalledTimes(4)
  })
  it('fails closed on malformed config or secret metadata without exposing content', async () => {
    const p = fixture()
    p.authConfig.mockResolvedValueOnce({ private: 'never' } as never)
    await expect(runFunctions(p, options, context)).rejects.toThrow('Configuração')
    p.secrets.mockResolvedValueOnce('private-never' as never)
    await expect(runFunctions(p, options, context)).rejects.toThrow('Metadados')
  })
  it('hook status reports installed pair metadata and never claims email delivery', async () => {
    const p = fixture()
    await runFunctions(p, options, context)
    expect(await runFunctions(p, { operation: 'functions-hook-status', environment: 'development' }, context)).toMatchObject({ hook: { enabled: true, targetMatchesProject: true, signingSecretConfigured: true }, deliveryVerified: false })
    installed = []
    expect(await runFunctions(p, { operation: 'functions-hook-status', environment: 'development' }, context)).toMatchObject({ hook: { signingSecretConfigured: false } })
  })
  it.each(['', 'https://foreign.test/send-email', uri + '?secret=private'])('never reflects arbitrary existing target URI %s', async target => {
    config = { ...config, hook_send_email_uri: target }
    const p = fixture()
    const result = await runFunctions(p, { operation: 'functions-hook-status', environment: 'development' }, context)
    expect(result).toMatchObject({ hook: { targetSlug: null, targetMatchesProject: false, signingSecretConfigured: false } })
    expect(p.secrets).not.toHaveBeenCalled()
  })
})
