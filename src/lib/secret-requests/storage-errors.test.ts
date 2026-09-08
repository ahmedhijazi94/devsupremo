import { describe, expect, it } from 'vitest'
import { safeSecretFailure } from './policy'
import { secretRequestStorageError } from './storage-errors'

describe('secret request database diagnostics', () => {
  it.each(['42703', '42P01', 'PGRST204', 'PGRST205'])('identifies unavailable structure from %s without assuming which migration is applied', (code) => {
    const result = safeSecretFailure(secretRequestStorageError({ code, message: 'target column private-value', details: 'private-value' }))
    expect(result.errorCode).toBe('schema_unavailable')
    expect(result.error).toContain('banco do Supremo')
    expect(result.error).toContain('recarregar seu esquema')
    expect(result.error).not.toMatch(/private-value|migration 024/)
  })
  it('distinguishes permission failure from migration failure without retrying with privileged access', () => {
    const result = safeSecretFailure(secretRequestStorageError({ code: '42501', message: 'permission denied private-value' }))
    expect(result.errorCode).toBe('access_denied')
    expect(result.error).toContain('permissões')
    expect(result.error).not.toMatch(/private-value|migration|atualização/)
  })
  it.each(['PGRST301', 'PGRST302', 'PGRST303'])('identifies rejected authentication %s without exposing the token', (code) => {
    const result = safeSecretFailure(secretRequestStorageError({ code, details: 'Bearer private-value' }))
    expect(result.errorCode).toBe('authentication_failed')
    expect(result.error).not.toContain('private-value')
  })
  it.each([{ code: 'PGRST003', message: 'pool timeout private-value' }, { code: '08006' }, { code: 'unrecognized-private-value', message: 'migration 024' }, null, new Error('private-value'), { code: 42703 }])('does not diagnose an unavailable connection or unknown failure as a missing migration %#', (error) => {
    const result = safeSecretFailure(secretRequestStorageError(error))
    expect(result.errorCode).toBe('storage_unavailable')
    expect(result.error).not.toMatch(/private-value|migration|atualização|permissões/)
  })
  it('does not expose unexpected exception codes or messages to callers', () => {
    const error = Object.assign(new Error('private-value'), { code: 'schema_unavailable', details: 'private-value' })
    expect(safeSecretFailure(error)).toEqual({ error: expect.not.stringContaining('private-value') })
  })
})
