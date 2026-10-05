import type { SupabaseClient } from '@supabase/supabase-js'
import type { OperationReceipt } from '../backend-operations/contract'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ project: vi.fn(), credentials: vi.fn(), environment: vi.fn(), policy: vi.fn(), receipts: new Map<string, OperationReceipt>() }))
vi.mock('../projects/repository', () => ({ getProject: mocks.project, getSupabaseCredentials: mocks.credentials }))
vi.mock('../database-environment/store', () => ({ readEnvironment: mocks.environment }))
vi.mock('../backend-operations/server', () => ({ authorizeProjectOperation: mocks.policy }))
vi.mock('../backend-operations/store', () => ({ backendOperationStore: (_client: unknown, scope: { id: string; capability: OperationReceipt['capability'] }) => ({
  claim: async () => {
    const prior = mocks.receipts.get(scope.id)
    if (prior) return { acquired: false, receipt: prior, token: 'claim' }
    const receipt: OperationReceipt = { id: scope.id, capability: scope.capability, environment: 'development', state: 'queued', updatedAt: '', message: '', result: null }
    mocks.receipts.set(scope.id, receipt)
    return { acquired: true, receipt, token: 'claim' }
  },
  update: async (id: string, _token: string, state: OperationReceipt['state'], message: string, result?: Record<string, unknown>) => {
    const receipt = { ...mocks.receipts.get(id)!, state, message, result: result ?? null }
    mocks.receipts.set(id, receipt)
    return receipt
  },
}) }))
import { runTrackedAuthOperation } from './tracked'
const ownerId = '11111111-1111-4111-8111-111111111111', projectId = '22222222-2222-4222-8222-222222222222'
const operationId = '33333333-3333-4333-8333-333333333333', userId = '44444444-4444-4444-8444-444444444444'
const authority = { client: {} as SupabaseClient, ownerId, projectId, deviceId: projectId, expectedRef: 'owned-ref', verifyIdentity: async () => ownerId }
const options = { operation: 'auth-invite', environment: 'development', email: 'person@example.test' } as const
beforeEach(() => {
  vi.resetAllMocks(); mocks.receipts.clear()
  mocks.project.mockResolvedValue({ id: projectId, supabase_project_ref: 'owned-ref', supabase_account_id: 'owned-account' })
  mocks.credentials.mockResolvedValue({ projectRef: 'owned-ref', token: 'management-fixture' })
  mocks.environment.mockResolvedValue({ project_ref: 'owned-ref', environment: 'development', source: 'supremo_provisioned' })
  mocks.policy.mockResolvedValue({ policyId: 'policy', revision: 'revision' })
})
afterEach(() => vi.unstubAllGlobals())

it.each(['accepted', 'lost-response', 'unconfirmed-user'] as const)('does not send the same invitation twice after %s', async outcome => {
  const user = { id: userId, email: options.email, invited_at: '2026-10-05T12:00:00.000Z', confirmation_token: 'private-value' }
  let invitations = 0
  vi.stubGlobal('fetch', vi.fn(async url => {
    if (String(url).endsWith('/api-keys')) return Response.json([{ name: 'service_role', api_key: 'admin-fixture' }])
    if (String(url).endsWith('/invite')) {
      invitations++
      if (outcome === 'lost-response') throw new Error('provider accepted but response lost')
      return Response.json(user)
    }
    return Response.json({ ...user, ...(outcome === 'unconfirmed-user' ? { invited_at: null } : {}) })
  }))
  const first = await runTrackedAuthOperation(authority, options, operationId)
  const second = await runTrackedAuthOperation(authority, options, operationId)
  const state = outcome === 'accepted' ? 'succeeded' : 'uncertain'
  expect(first).toMatchObject({ receipt: { state, capability: 'auth.invite' } })
  expect(second).toEqual(first)
  expect(invitations).toBe(1)
  expect(JSON.stringify(first)).not.toContain('private-value')
  expect(mocks.policy).toHaveBeenCalledWith(expect.objectContaining({ environment: 'development', deviceId: projectId }), 'auth.invite', { rows: 1, resource: 'auth.invite:person@example.test' })
  if (outcome === 'accepted') expect(first).toMatchObject({ data: { invitationAccepted: true, userObserved: true, deliveryVerified: false } })
  else expect(first).toMatchObject({ receipt: { result: null } })
})

it('does not claim or dispatch a recipient outside the policy', async () => {
  mocks.policy.mockRejectedValue(new Error('Recipient outside authorized resources'))
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
  await expect(runTrackedAuthOperation(authority, options, operationId)).rejects.toThrow('Recipient')
  expect(mocks.receipts.size).toBe(0)
  expect(fetcher).not.toHaveBeenCalled()
})
it('rechecks the recipient grant after service-key lookup and prevents sending if revoked', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => {
    mocks.policy.mockRejectedValue(new Error('Invitation grant revoked'))
    return Response.json([{ name: 'service_role', api_key: 'admin-fixture' }])
  })
  vi.stubGlobal('fetch', fetcher)
  expect(await runTrackedAuthOperation(authority, options, operationId)).toMatchObject({ receipt: { state: 'uncertain', result: null } })
  expect(fetcher).toHaveBeenCalledOnce()
  expect(fetcher.mock.calls[0]?.[0]).toBe('https://api.supabase.com/v1/projects/owned-ref/api-keys')
})
