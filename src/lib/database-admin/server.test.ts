import type { SupabaseClient } from '@supabase/supabase-js'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ project: vi.fn(), credentials: vi.fn(), environment: vi.fn(), policy: vi.fn() }))
vi.mock('../projects/repository', () => ({ getProject: mocks.project, getSupabaseCredentials: mocks.credentials }))
vi.mock('../database-environment/store', () => ({ readEnvironment: mocks.environment }))
vi.mock('../backend-operations/server', () => ({ authorizeProjectOperation: mocks.policy }))
import { runAuthorizedAuthOperation } from './server'
const ownerId = '11111111-1111-4111-8111-111111111111', projectId = '22222222-2222-4222-8222-222222222222', userId = '33333333-3333-4333-8333-333333333333'
const project = { id: projectId, supabase_project_ref: 'auth-ref', supabase_account_id: 'account' }
const authority = () => ({ client: {} as SupabaseClient, ownerId, projectId, deviceId: projectId, expectedRef: 'auth-ref', verifyIdentity: vi.fn(async () => ownerId) })
const users = [{ id: userId, email: 'private@example.test', created_at: '2026-10-05T00:00:00Z', email_confirmed_at: null, last_sign_in_at: null, banned_until: null }]
const read = { operation: 'auth-users', environment: 'development', limit: 50, offset: 0 } as const
const fetchMock = vi.fn<typeof fetch>()
beforeEach(() => {
  vi.resetAllMocks(); vi.stubGlobal('fetch', fetchMock)
  mocks.project.mockResolvedValue(project); mocks.credentials.mockResolvedValue({ projectRef: 'auth-ref', token: 'private-management' })
  mocks.environment.mockResolvedValue({ project_ref: 'auth-ref', environment: 'development', source: 'supremo_provisioned' })
  mocks.policy.mockResolvedValue({ policyId: 'policy', revision: 'revision' }); fetchMock.mockImplementation(async () => Response.json(users))
})
afterEach(() => vi.unstubAllGlobals())
describe('Auth provider boundaries', () => {
  it('returns a projected authorized read only after fresh identity, target and policy checks', async () => {
    const scope = authority()
    expect(await runAuthorizedAuthOperation(scope, read)).toMatchObject({ readOnly: true, data: { users } })
    expect(mocks.policy).toHaveBeenLastCalledWith(expect.objectContaining({ deviceId: projectId }), 'auth.read', { rows: 50, resource: 'auth.users' })
    expect(scope.verifyIdentity.mock.calls.length).toBeGreaterThan(2)
  })
  it.each(['device', 'policy', 'account', 'ref'] as const)('discards Auth read data when %s changes while the provider is responding', async field => {
    const scope = authority()
    fetchMock.mockImplementationOnce(async () => {
      if (field === 'device') scope.verifyIdentity.mockResolvedValue(projectId)
      if (field === 'policy') mocks.policy.mockResolvedValue({ policyId: 'policy', revision: 'revoked' })
      if (field === 'account') mocks.project.mockResolvedValue({ ...project, supabase_account_id: 'other-account' })
      if (field === 'ref') mocks.project.mockResolvedValue({ ...project, supabase_project_ref: 'other-ref' })
      return Response.json(users)
    })
    await expect(runAuthorizedAuthOperation(scope, read)).rejects.toThrow()
    expect(fetchMock).toHaveBeenCalledOnce()
  })
  it('checks owner-session reads after provider responses too, while preserving explicit owner authority', async () => {
    const scope = authority()
    expect(await runAuthorizedAuthOperation({ ...scope, ownerSession: true }, read)).toMatchObject({ readOnly: true })
    expect(mocks.policy).not.toHaveBeenCalled()
    fetchMock.mockImplementationOnce(async () => { scope.verifyIdentity.mockResolvedValue(projectId); return Response.json(users) })
    await expect(runAuthorizedAuthOperation({ ...scope, ownerSession: true }, read)).rejects.toThrow('Identidade')
  })
  it.each(['auth.sessions', 'role:editor'])('fences secondary %s grant revoked during credential lookup before sending role SQL', async revoked => {
    let blocked = false
    mocks.policy.mockImplementation(async (_scope: unknown, capability: string, effects: { resource: string }) => {
      if (blocked && (revoked === capability || revoked === effects.resource)) throw new Error('One-time grant revoked')
      return { policyId: 'policy', revision: 'revision' }
    })
    mocks.credentials.mockImplementationOnce(async () => { blocked = true; return { projectRef: 'auth-ref', token: 'private-management' } })
    await expect(runAuthorizedAuthOperation(authority(), { operation: 'auth-role-set', environment: 'development', userId, roles: ['editor'], manifestVersion: 1 })).rejects.toThrow('grant revoked')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
