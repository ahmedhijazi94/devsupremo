import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { runFunctions } from './service'
import { sealFunctionArtifact, openFunctionArtifact } from './artifacts'
import type { FunctionProvider } from './provider'
import { FUNCTION_HOOK_SECRET_NAME, type FunctionDeploy } from './contract'
import { deriveHookSecret, hookSecretDigest } from './policy'
const scope = { ownerId: '11111111-1111-4111-8111-111111111111', projectId: '22222222-2222-4222-8222-222222222222', projectRef: 'fixture', environment: 'development' as const }
const record = { id: 'function-id', slug: 'daily', version: 2, status: 'ACTIVE', verify_jwt: false }
const bundle: FunctionDeploy = { environment: 'development', slug: 'daily', entrypoint: 'supabase/functions/daily/index.ts', files: [{ path: 'supabase/functions/daily/index.ts', content: 'Deno.serve(handler)' }], verifyJwt: false }
function fixture() {
  const secret = deriveHookSecret({ ...scope, slug: 'previous', secretName: FUNCTION_HOOK_SECRET_NAME })
  let config = { hook_send_email_uri: 'https://fixture.supabase.co/functions/v1/previous', hook_send_email_enabled: true, hook_send_email_secrets: secret, external_email_enabled: true }
  const provider = { list: vi.fn(async () => [record]), get: vi.fn<FunctionProvider['get']>(async () => record), deploy: vi.fn(async () => record), authConfig: vi.fn(async () => config), secrets: vi.fn(async () => [{ name: FUNCTION_HOOK_SECRET_NAME, value: hookSecretDigest(secret) }]), setSecret: vi.fn(async () => undefined), probe: vi.fn<FunctionProvider['probe']>(async (_slug, value, validity) => value && (!validity || validity === 'valid') ? 400 : 401), configureHook: vi.fn(async (uri: string, value: string) => { config = { ...config, hook_send_email_uri: uri, hook_send_email_secrets: value } }), disableHook: vi.fn(async () => { config = { ...config, hook_send_email_enabled: false } }), dependencies: vi.fn(async () => 0), remove: vi.fn(async () => undefined), artifact: vi.fn(async () => bundle) } satisfies FunctionProvider
  return provider
}
beforeEach(() => vi.stubEnv('ENCRYPTION_KEY', 'a'.repeat(64)))
afterEach(() => vi.unstubAllEnvs())
describe('function lifecycle', () => {
  it('removes only the inspected version after checking dependencies, then reads absence', async () => {
    const p = fixture(); p.get.mockResolvedValueOnce(record).mockResolvedValueOnce(record).mockResolvedValueOnce(null)
    expect(await runFunctions(p, { operation: 'functions-remove', environment: 'development', slug: 'daily', expectedVersion: 2 }, scope)).toEqual({ slug: 'daily', removed: true, verified: true })
    expect(p.dependencies).toHaveBeenCalledWith('daily'); expect(p.remove).toHaveBeenCalledOnce()
  })
  it('blocks dependencies, changed version and unconfirmed removal', async () => {
    const options = { operation: 'functions-remove', environment: 'development', slug: 'daily', expectedVersion: 2 } as const
    const p = fixture(); p.dependencies.mockResolvedValueOnce(1)
    await expect(runFunctions(p, options, scope)).rejects.toThrow('referenciada'); expect(p.remove).not.toHaveBeenCalled()
    await expect(runFunctions(p, { ...options, expectedVersion: 1 }, scope)).rejects.toThrow('versão mudou')
    p.get.mockResolvedValueOnce(record).mockResolvedValueOnce({ ...record, version: 3 })
    await expect(runFunctions(p, options, scope)).rejects.toThrow('mudou durante')
    await expect(runFunctions(p, options, scope)).rejects.toThrow('não confirmada')
  })
  it('restores only a known artifact into the same environment and reads the deployed version', async () => {
    const p = fixture(), options = { operation: 'functions-rollback', environment: 'development', slug: 'daily', expectedVersion: 2, version: 1 } as const
    expect(await runFunctions(p, options, scope)).toMatchObject({ restoredFromVersion: 1, verified: true, deliveryVerified: false })
    expect(p.deploy).toHaveBeenCalledWith(bundle)
    p.artifact.mockResolvedValueOnce({ ...bundle, environment: 'production' })
    await expect(runFunctions(p, options, scope)).rejects.toThrow('outro destino')
  })
  it('replaces only the explicitly named hook preserving its secret and signature tests', async () => {
    const p = fixture(), options = { operation: 'functions-hook-configure', environment: 'development', slug: 'daily', secretName: FUNCTION_HOOK_SECRET_NAME } as const
    await expect(runFunctions(p, options, scope)).rejects.toThrow('outro destino')
    expect(await runFunctions(p, { ...options, replaceSlug: 'previous' }, scope)).toMatchObject({ verified: true, deliveryVerified: false, hook: { targetSlug: 'daily' } })
    expect(p.probe).toHaveBeenCalledTimes(4); expect(p.setSecret).not.toHaveBeenCalled()
  })
  it('disables only the named hook and proves disabled without claiming delivery', async () => {
    const p = fixture(), options = { operation: 'functions-hook-disable', environment: 'development', slug: 'previous' } as const
    await expect(runFunctions(p, { ...options, slug: 'unrelated' }, scope)).rejects.toThrow('não corresponde')
    expect(await runFunctions(p, options, scope)).toMatchObject({ disabled: true, verified: true, deliveryVerified: false, hook: { enabled: false } })
    await runFunctions(p, options, scope); expect(p.disableHook).toHaveBeenCalledOnce()
  })
  it('authenticates archived content, version and complete project binding without exposing source', () => {
    const sealed = sealFunctionArtifact(scope, bundle, 1)
    expect(sealed.encryptedBundle).not.toContain('Deno.serve')
    expect(openFunctionArtifact(scope, 'daily', 1, sealed.encryptedBundle, sealed.bundleHash)).toEqual(bundle)
    for (const changed of [{ ...scope, ownerId: 'other' }, { ...scope, projectRef: 'another' }, { ...scope, environment: 'production' as const }]) expect(() => openFunctionArtifact(changed, 'daily', 1, sealed.encryptedBundle, sealed.bundleHash)).toThrow()
    expect(() => openFunctionArtifact(scope, 'daily', 2, sealed.encryptedBundle, sealed.bundleHash)).toThrow()
    expect(() => openFunctionArtifact(scope, 'daily', 1, sealed.encryptedBundle, 'bad')).toThrow()
    expect(() => openFunctionArtifact(scope, 'daily', 1, 'tampered', sealed.bundleHash)).toThrow()
  })
  it('reads only known scoped history/code and keeps protected literal content out of the response', async () => {
    const p = fixture(), history = { versions: [{ version: 1, createdAt: '2026-10-05T00:00:00Z', hash: 'a'.repeat(64) }], complete: true }
    await expect(runFunctions(p, { operation: 'functions-history', slug: 'daily', environment: 'development' }, scope)).rejects.toThrow('indisponível')
    expect(await runFunctions({ ...p, artifactHistory: async () => history }, { operation: 'functions-history', slug: 'daily', environment: 'development' }, scope)).toEqual(history)
    p.artifact.mockResolvedValueOnce({ ...bundle, files: [{ path: bundle.entrypoint, content: 'const password = "must-remain-private"' }] })
    const view = await runFunctions(p, { operation: 'functions-code', slug: 'daily', version: 1, environment: 'development' }, scope)
    expect(JSON.stringify(view)).not.toContain('must-remain-private'); expect(view).toMatchObject({ sanitized: true, exactSource: false })
    p.artifact.mockResolvedValueOnce({ ...bundle, environment: 'production' })
    await expect(runFunctions(p, { operation: 'functions-code', slug: 'daily', version: 1, environment: 'development' }, scope)).rejects.toThrow('outro destino')
  })
  it('tests the installed hook without changing config or claiming delivery, and refuses arbitrary functions', async () => {
    const p = fixture(), options = { operation: 'functions-test', environment: 'development', slug: 'previous', expectedVersion: 2 } as const
    p.get.mockResolvedValue({ ...record, slug: 'previous' })
    expect(await runFunctions(p, options, scope)).toMatchObject({ signatureVerified: true, requests: 4, payload: 'empty_object', deliveryVerified: false })
    expect(p.probe).toHaveBeenCalledTimes(4); expect(p.configureHook).not.toHaveBeenCalled(); expect(p.setSecret).not.toHaveBeenCalled()
    await expect(runFunctions(p, { ...options, expectedVersion: 1 }, scope)).rejects.toThrow('versão atual')
    p.probe.mockResolvedValueOnce(200)
    await expect(runFunctions(p, options, scope)).rejects.toThrow('comportamento')
    p.get.mockResolvedValueOnce({ ...record, slug: 'previous' }).mockResolvedValueOnce({ ...record, slug: 'previous', version: 3 })
    await expect(runFunctions(p, options, scope)).rejects.toThrow('mudou durante')
  })
})
