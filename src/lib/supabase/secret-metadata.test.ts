import { describe, expect, it } from 'vitest'
import { parseSupabaseSecretMetadata } from './secret-metadata'

const fingerprint = '1234567890abcdef'.repeat(4)
const row = { name: 'AUTH_SEND_EMAIL_HOOK_SECRET', value: fingerprint, updated_at: '2026-09-26T12:00:00Z' }

describe('Supabase secret list response contract', () => {
  it('normalizes the documented value fingerprint and discards all other provider fields', () => {
    expect(parseSupabaseSecretMetadata([{ ...row, value: fingerprint.toUpperCase(), internal: 'never' }]))
      .toEqual([{ name: row.name, digest: fingerprint }])
    expect(parseSupabaseSecretMetadata([{ name: row.name, value: fingerprint }])).toEqual([{ name: row.name, digest: fingerprint }])
    expect(parseSupabaseSecretMetadata([])).toEqual([])
  })
  it('accepts a redundant alias only when it agrees with the documented value', () => {
    expect(parseSupabaseSecretMetadata([{ ...row, digest: fingerprint.toUpperCase() }])).toEqual([{ name: row.name, digest: fingerprint }])
    expect(parseSupabaseSecretMetadata([{ ...row, digest: 'f'.repeat(64) }])).toBeNull()
    expect(parseSupabaseSecretMetadata([{ name: row.name, digest: fingerprint }])).toBeNull()
  })
  it('rejects duplicate names even with identical digests or in unrelated secrets', () => {
    expect(parseSupabaseSecretMetadata([row, { ...row }])).toBeNull()
    expect(parseSupabaseSecretMetadata([row, { ...row, value: 'f'.repeat(64) }])).toBeNull()
    expect(parseSupabaseSecretMetadata([row, { name: 'OTHER', value: fingerprint }, { name: 'OTHER', value: fingerprint }])).toBeNull()
  })
  it.each([null, {}, { secrets: [row] }, 'private-secret', [null], [{ ...row, name: '' }], [{ ...row, name: 'x'.repeat(129) }],
    [{ ...row, value: 'private-secret' }], [{ ...row, value: fingerprint + '\n' }], [{ ...row, value: 'z'.repeat(64) }],
    [{ ...row, value: undefined }], [{ ...row, value: 42 }], [{ ...row, digest: null }], [{ ...row, updated_at: null }],
    [{ ...row, updated_at: 'x'.repeat(257) }], Array.from({ length: 1001 }, (_, index) => ({ ...row, name: `SECRET_${index}` }))].map(raw => ({ raw })))
  ('rejects malformed or unbounded metadata without returning inputs or diagnostics (%#)', ({ raw }) => {
    expect(parseSupabaseSecretMetadata(raw)).toBeNull()
  })
})
