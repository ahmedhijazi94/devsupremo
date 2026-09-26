import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHmac } from 'node:crypto'
import { deriveHookSecret, hookSecretDigest, hookSignature, isValidHookSecret, requireFunctionTarget } from './policy'
const context = { ownerId: '00000000-0000-4000-8000-000000000001', projectId: '00000000-0000-4000-8000-000000000002',
  projectRef: 'dev-ref', environment: 'development' as const, slug: 'send-email', secretName: 'AUTH_SEND_EMAIL_HOOK_SECRET' as const }
afterEach(() => vi.unstubAllEnvs())
describe('private hook signing and development authorization', () => {
  it('requires registered same-ref explicitly selected environment for all operations', () => {
    const record = { project_ref: 'dev-ref', environment: 'development', source: 'supremo_provisioned' }
    expect(requireFunctionTarget(record, 'dev-ref', { expectedRef: 'dev-ref', environment: 'development' })).toBe('dev-ref')
    for (const [state, linked, requested] of [[null, 'dev-ref', 'dev-ref'], [{ ...record, environment: 'production' }, 'dev-ref', 'dev-ref'],
      [{ ...record, source: 'user' }, 'dev-ref', 'dev-ref'], [record, 'other', 'dev-ref'], [record, 'dev-ref', 'other'], [record, null, 'dev-ref']] as const)
      expect(() => requireFunctionTarget(state, linked, { expectedRef: requested, environment: 'development' })).toThrow()
    expect(() => requireFunctionTarget(record, 'dev-ref', { expectedRef: 'dev-ref', environment: 'production' })).toThrow()
    expect(requireFunctionTarget({ ...record, environment: 'production' }, 'dev-ref', { expectedRef: 'dev-ref', environment: 'production' })).toBe('dev-ref')
  })
  it('converges on same scope and separates independent owners, projects, refs and functions', () => {
    vi.stubEnv('ENCRYPTION_KEY', 'a'.repeat(64))
    const original = deriveHookSecret(context)
    expect(isValidHookSecret(original)).toBe(true)
    expect(deriveHookSecret(context)).toBe(original)
    for (const change of [{ ownerId: '00000000-0000-4000-8000-000000000003' }, { projectId: '00000000-0000-4000-8000-000000000003' }, { projectRef: 'other-ref' }, { slug: 'another' }, { environment: 'production' as const }])
      expect(deriveHookSecret({ ...context, ...change })).not.toBe(original)
    vi.stubEnv('ENCRYPTION_KEY', 'b'.repeat(64))
    expect(deriveHookSecret(context)).not.toBe(original)
  })
  it.each(['', 'a'.repeat(63), 'g'.repeat(64), 'ab', 'a'.repeat(64) + '\n'])('fails closed with malformed master key', key => {
    vi.stubEnv('ENCRYPTION_KEY', key)
    expect(() => deriveHookSecret(context)).toThrow('indisponível')
  })
  it('does not derive from an unknown environment or arbitrary destination name', () => {
    vi.stubEnv('ENCRYPTION_KEY', 'a'.repeat(64))
    expect(() => deriveHookSecret({ ...context, environment: 'unknown' } as never)).toThrow()
    expect(() => deriveHookSecret({ ...context, secretName: 'OTHER' } as never)).toThrow()
    expect(() => deriveHookSecret({ ...context, ownerId: 'not-owner' })).toThrow()
  })
  it('accepts canonical long private keys and rejects masked, short, noncanonical or multi-key values', () => {
    const secret = `v1,whsec_${Buffer.alloc(32, 1).toString('base64')}`
    expect(isValidHookSecret(secret)).toBe(true)
    for (const value of [undefined, '', '***', 'v1,whsec_YQ==', secret + '\n', secret + '|' + secret, secret.replace('=', '')]) expect(isValidHookSecret(value)).toBe(false)
    expect(hookSecretDigest(secret)).toMatch(/^[a-f0-9]{64}$/)
  })
  it('signs the Standard Webhooks raw id.timestamp.payload format', () => {
    const raw = Buffer.alloc(32, 5)
    const secret = `v1,whsec_${raw.toString('base64')}`
    expect(hookSignature(secret, 'id', '123', '{}')).toBe(`v1,${createHmac('sha256', raw).update('id.123.{}').digest('base64')}`)
    expect(() => hookSignature('invalid', 'id', '123', '{}')).toThrow()
  })
})
