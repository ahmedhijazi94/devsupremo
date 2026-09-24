import { randomBytes } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { decryptCredential, encryptCredential, type CredentialEncryptionContext } from './crypto'

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>()
  return { ...actual, randomBytes: vi.fn(actual.randomBytes) }
})

const context: CredentialEncryptionContext = {
  id: '12345678-aaaa-4000-8000-123456789012',
  userId: 'aaaaaaaa-bbbb-4000-8000-123456789012',
  projectId: 'bbbbbbbb-cccc-4000-8000-123456789012',
  environment: 'development',
}
const testKey = 'ab'.repeat(32)

beforeEach(() => vi.stubEnv('ENCRYPTION_KEY', testKey))
afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

describe('project credential encryption', () => {
  it.each([
    'test-provider-credential',
    '{"type":"service_account","private_key":"line1\\nline2"}',
    '-----BEGIN TEST-----\nline 1\nline 2\n-----END TEST-----\n',
    '  leading and trailing whitespace  ',
    'acentuação e emoji 🔐',
    'x'.repeat(16_384),
    '🔐'.repeat(4_096),
  ])('round-trips an arbitrary private value without normalization %#', (value) => {
    const encrypted = encryptCredential(value, context)
    expect(encrypted).toMatch(/^v1:[0-9a-f]{24}:[0-9a-f]{32}:(?:[0-9a-f]{2})+$/)
    expect(encrypted).not.toContain(value)
    expect(decryptCredential(encrypted, context)).toBe(value)
  })

  it('generates a fresh 96-bit nonce even for repeated values and scope', () => {
    const first = encryptCredential('identical-test-value', context)
    const second = encryptCredential('identical-test-value', context)
    expect(first.split(':')[1]).not.toBe(second.split(':')[1])
    expect(first).not.toBe(second)
  })

  it.each(['development', 'preview', 'production'] as const)('supports the %s scope', (environment) => {
    const scoped = { ...context, environment }
    expect(decryptCredential(encryptCredential('value', scoped), scoped)).toBe('value')
  })

  it('canonicalizes UUID casing independently of database serialization', () => {
    const uppercase = {
      ...context, id: context.id.toUpperCase(),
      userId: context.userId.toUpperCase(), projectId: context.projectId.toUpperCase(),
    }
    const encrypted = encryptCredential('value', uppercase)
    expect(decryptCredential(encrypted, context)).toBe('value')
  })

  it('accepts uppercase hexadecimal key material', () => {
    vi.stubEnv('ENCRYPTION_KEY', testKey.toUpperCase())
    const encrypted = encryptCredential('value', context)
    vi.stubEnv('ENCRYPTION_KEY', testKey)
    expect(decryptCredential(encrypted, context)).toBe('value')
  })

  it.each([
    '', '\0', 'before\0after', 'x'.repeat(16_385), '🔐'.repeat(4_097), '\uD800',
    undefined, null, 42, {},
  ])('rejects an invalid or oversized plaintext %# without echoing it', (value) => {
    expect(() => encryptCredential(value as string, context)).toThrow('Valor da credencial inválido.')
  })

  it('never exposes crypto engine errors or their input values', () => {
    vi.mocked(randomBytes).mockImplementationOnce(() => { throw new Error('private implementation detail') })
    expect(() => encryptCredential('private-test-value', context)).toThrow('Não foi possível proteger a credencial.')
  })
})

describe('credential scope and integrity', () => {
  it.each([
    { id: 'cccccccc-cccc-4000-8000-123456789012' },
    { userId: 'cccccccc-cccc-4000-8000-123456789012' },
    { projectId: 'cccccccc-cccc-4000-8000-123456789012' },
    { environment: 'production' as const },
    { environment: 'preview' as const },
  ])('rejects transplanting ciphertext to another authorized scope %#', (changed) => {
    const encrypted = encryptCredential('sensitive-value', context)
    expect(() => decryptCredential(encrypted, { ...context, ...changed }))
      .toThrow('Não foi possível acessar a credencial protegida.')
  })

  it.each([1, 2, 3])('rejects tampering in envelope segment %s', (index) => {
    const parts = encryptCredential('private-test-value', context).split(':')
    const segment = parts[index]!
    parts[index] = `${segment[0] === '0' ? '1' : '0'}${segment.slice(1)}`
    expect(() => decryptCredential(parts.join(':'), context))
      .toThrow('Não foi possível acessar a credencial protegida.')
  })

  it('rejects the wrong key with a sanitized error', () => {
    const encrypted = encryptCredential('sensitive-value', context)
    vi.stubEnv('ENCRYPTION_KEY', 'cd'.repeat(32))
    expect(() => decryptCredential(encrypted, context))
      .toThrow('Não foi possível acessar a credencial protegida.')
  })

  it.each([
    {}, null, undefined,
    { ...context, id: 'untrusted-value' },
    { ...context, id: `${context.id}\n` },
    { ...context, userId: 'untrusted-value' },
    { ...context, projectId: 'untrusted-value' },
    { ...context, environment: 'other' },
    { ...context, extra: 'untrusted-value' },
  ])('rejects malformed runtime scope %# on both operations', (invalid) => {
    const encrypted = encryptCredential('value', context)
    expect(() => encryptCredential('value', invalid as CredentialEncryptionContext))
      .toThrow('Contexto da credencial inválido.')
    expect(() => decryptCredential(encrypted, invalid as CredentialEncryptionContext))
      .toThrow('Contexto da credencial inválido.')
  })
})

describe('credential envelope and server key validation', () => {
  it.each([
    undefined, '', 'a'.repeat(63), 'a'.repeat(65), 'z'.repeat(64), 'ab'.repeat(31) + ' x', `${testKey}\n`,
  ])('rejects absent, malformed or wrong-size keys %# before crypto', (key) => {
    const encrypted = encryptCredential('private-value', context)
    vi.stubEnv('ENCRYPTION_KEY', key)
    expect(() => encryptCredential('private-value', context))
      .toThrow('A chave de criptografia do cofre não está configurada corretamente.')
    expect(() => decryptCredential(encrypted, context))
      .toThrow('A chave de criptografia do cofre não está configurada corretamente.')
  })

  it.each([
    '', 'plaintext', 'a:b:c', null, undefined, {}, 42,
    `v2:${'a'.repeat(24)}:${'a'.repeat(32)}:aa`,
    `v1:${'a'.repeat(23)}:${'a'.repeat(32)}:aa`,
    `v1:${'a'.repeat(24)}:${'a'.repeat(31)}:aa`,
    `v1:${'a'.repeat(24)}:${'a'.repeat(32)}:`,
    `v1:${'a'.repeat(24)}:${'a'.repeat(32)}:a`,
    `v1:${'a'.repeat(24)}:${'a'.repeat(32)}:zz`,
    `v1:${'a'.repeat(24)}:${'a'.repeat(32)}:${'aa'.repeat(16_385)}`,
    `v1:${'a'.repeat(24)}:${'a'.repeat(32)}:aa:extra`,
    `v1:${'a'.repeat(24)}:${'a'.repeat(32)}:aa\r\n`,
  ])('rejects malformed, unsupported or oversized envelopes %# without exposing them', (invalid) => {
    expect(() => decryptCredential(invalid as string, context))
      .toThrow('Formato da credencial protegida inválido.')
  })
})
