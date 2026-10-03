import { describe, expect, it } from 'vitest'
import { deleteOptionsSchema, deleteRequestSchema } from './contract'

const plan = { operation: 'data-delete-plan', environment: 'development', targets: [{ table: 'orgs', key: { id: 'company-id' } }] }
describe('bounded data deletion contract', () => {
  it('accepts only exact primary key targets and explicit development', () => {
    expect(deleteOptionsSchema.parse(plan)).toEqual(plan)
    expect(deleteOptionsSchema.parse({ ...plan, targets: [{ table: 'memberships', key: { org_id: 'company', user_id: 'owner' } }] })).toBeTruthy()
  })
  it.each([
    { environment: 'production' }, { environment: 'unknown' }, { environment: undefined },
    { sql: 'delete from orgs' }, { ownerId: 'chosen-owner' }, { targets: [] },
    { targets: Array.from({ length: 26 }, () => plan.targets[0]) },
    { targets: [{ table: 'auth.users', key: { id: 'user' } }] },
    { targets: [{ table: 'orgs', key: {} }] },
    { targets: [{ table: 'orgs', key: { 'id;drop': 'user' } }] },
    { targets: [{ table: 'orgs', key: { id: null } }] },
    { targets: [{ table: 'orgs', key: { id: 'x' }, cascade: true }] },
  ])('rejects ambiguous or broader scope %j', patch => {
    expect(deleteOptionsSchema.safeParse({ ...plan, ...patch }).success).toBe(false)
  })
  it('requires a server plan and authorization for execution', () => {
    expect(deleteOptionsSchema.safeParse({ operation: 'data-delete-apply', environment: 'development', planToken: 'a'.repeat(100), authorization: '   ' }).success).toBe(false)
    expect(deleteOptionsSchema.safeParse({ operation: 'data-delete-apply', environment: 'development', targets: plan.targets, authorization: 'Delete the requested company' }).success).toBe(false)
    expect(deleteOptionsSchema.safeParse({ operation: 'data-delete-apply', environment: 'development', planToken: 'a'.repeat(100), authorization: 'Delete the requested company' }).success).toBe(true)
  })
  it('accepts device identity and reference only in the transport contract', () => {
    const request = { ...plan, projectId: '00000000-0000-4000-8000-000000000001', deviceSecret: 'test-device-secret', expectedRef: 'test-ref' }
    expect(deleteRequestSchema.safeParse(request).success).toBe(true)
    expect(deleteOptionsSchema.safeParse(request).success).toBe(false)
    expect(deleteRequestSchema.safeParse({ ...request, token: 'provider-token' }).success).toBe(false)
  })
})
