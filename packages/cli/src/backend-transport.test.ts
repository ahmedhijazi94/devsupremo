import { describe, expect, it } from 'vitest'
import { parseDatabaseOptions } from './database-request'
import { secretOperationReceipt } from './project-service-request'

const id = '11111111-1111-4111-8111-111111111111'
describe('durable administrative request contracts', () => {
  it.each(['migrate', 'anonymous-auth', 'cron-apply', 'secrets-revoke-credential'] as const)('keeps the same operation ID across queue and dispatch for %s', operation => {
    const first = parseDatabaseOptions(operation, operation === 'secrets-revoke-credential' ? { credentialId: id } : {})
    expect(first.operationId).toMatch(/^[a-f0-9-]{36}$/)
    expect(parseDatabaseOptions(operation, first).operationId).toBe(first.operationId)
  })
  it('does not turn missing or mismatched credential receipts into success', () => {
    const receipt = { id, capability: 'credentials.use', environment: 'development', state: 'uncertain', updatedAt: '2026-10-05T00:00:00Z', result: { private: 'never-exposed' } }
    expect(secretOperationReceipt({ receipt }, id)).toMatchObject({ id, state: 'uncertain' })
    expect(JSON.stringify(secretOperationReceipt({ receipt }, id))).not.toContain('never-exposed')
    expect(() => secretOperationReceipt({ requests: [{ status: 'fulfilled' }] }, id)).toThrow('não confirmou')
    expect(() => secretOperationReceipt({ receipt: { ...receipt, id: '22222222-2222-4222-8222-222222222222' } }, id)).toThrow()
  })
  it('restricts approval lookups to an exact UUID and accepts no owner or grant from the agent', () => {
    expect(parseDatabaseOptions('backend-approval-status', { operationId: id })).toEqual({ operationId: id })
    expect(() => parseDatabaseOptions('backend-approval-status', { operationId: id, approved: true })).toThrow()
    expect(() => parseDatabaseOptions('backend-approval-status', { operationId: 'other' })).toThrow()
  })
})
