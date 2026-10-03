import type { SupabaseClient } from '@supabase/supabase-js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runAuthorizedDelete } from './server'
import { runDataDelete, type DeleteDependencies } from './service'
import { getProject, getSupabaseCredentials } from '../projects/repository'
import { readEnvironment } from '../database-environment/store'

vi.mock('./service', () => ({ runDataDelete: vi.fn() }))
vi.mock('../projects/repository', () => ({ getProject: vi.fn(), getSupabaseCredentials: vi.fn() }))
vi.mock('../database-environment/store', () => ({ readEnvironment: vi.fn() }))
const ownerId = '00000000-0000-4000-8000-000000000001'
const projectId = '00000000-0000-4000-8000-000000000002'
const accountId = '00000000-0000-4000-8000-000000000003'
const insert = vi.fn()
const client = { from: vi.fn(() => ({ insert })) } as unknown as SupabaseClient
const verifyIdentity = vi.fn()
const authority = { client, ownerId, projectId, expectedRef: 'dev-ref', verifyIdentity }
const options = { operation: 'data-delete-plan' as const, environment: 'development' as const, targets: [{ table: 'orgs', key: { id: 'company-id' } }] }
const project = { id: projectId, user_id: ownerId, supabase_project_ref: 'dev-ref', supabase_account_id: accountId } as Awaited<ReturnType<typeof getProject>>
let deps: DeleteDependencies
beforeEach(() => {
  vi.clearAllMocks()
  verifyIdentity.mockResolvedValue(ownerId)
  vi.mocked(getProject).mockResolvedValue(project)
  vi.mocked(getSupabaseCredentials).mockResolvedValue({ token: 'private-token', projectRef: 'dev-ref' })
  vi.mocked(readEnvironment).mockResolvedValue({ environment: 'development', source: 'supremo_provisioned', project_ref: 'dev-ref' })
  insert.mockResolvedValue({ error: null })
  vi.mocked(runDataDelete).mockImplementation(async value => { deps = value; return {} as never })
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json([])))
})
afterEach(() => vi.unstubAllGlobals())

describe('owner-authorized deletion service boundary', () => {
  it.each(['production', 'unknown'] as const)('rejects %s before plan or credentials', async environment => {
    vi.mocked(readEnvironment).mockResolvedValue(environment === 'unknown' ? null : { environment, source: 'supremo_provisioned', project_ref: 'dev-ref' })
    await expect(runAuthorizedDelete(authority, options)).rejects.toThrow('development')
    expect(runDataDelete).not.toHaveBeenCalled()
    expect(getSupabaseCredentials).not.toHaveBeenCalled()
  })
  it('checks live owner, target and account on every database call', async () => {
    await runAuthorizedDelete(authority, options)
    expect(await deps.authorize()).toMatchObject({ ownerId, projectId, accountId, projectRef: 'dev-ref' })
    await deps.provider.query('SELECT 1', true)
    expect(getSupabaseCredentials).toHaveBeenCalledWith(ownerId, project)
    vi.mocked(getProject).mockResolvedValue({ ...project, supabase_account_id: '00000000-0000-4000-8000-000000000004' })
    await expect(deps.provider.query('write', false)).rejects.toThrow('Conta')
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('blocks cross-owner, revoked device, wrong credential ref and removed account', async () => {
    verifyIdentity.mockResolvedValue('other')
    await expect(runAuthorizedDelete(authority, options)).rejects.toThrow('Dispositivo')
    verifyIdentity.mockResolvedValue(ownerId)
    vi.mocked(getProject).mockRejectedValueOnce(new Error('not-owned'))
    await expect(runAuthorizedDelete(authority, options)).rejects.toThrow('not-owned')
    vi.mocked(getProject).mockResolvedValueOnce({ ...project, supabase_account_id: null })
    await expect(runAuthorizedDelete(authority, options)).rejects.toThrow('Conta')
    await runAuthorizedDelete(authority, options)
    vi.mocked(getSupabaseCredentials).mockResolvedValue({ projectRef: 'other', token: 'private' })
    await expect(deps.provider.query('write', false)).rejects.toThrow('Vínculo')
    expect(fetch).not.toHaveBeenCalled()
  })
  it('consumes plan UUID atomically in append-only audit; duplicate or failed audit blocks execution', async () => {
    await runAuthorizedDelete(authority, options)
    const event = { event: 'claimed' as const, planId: projectId, metadata: { impactCount: 2 } }
    await deps.audit(event)
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ id: projectId, user_id: ownerId, resource_id: projectId, action: 'data-delete.claimed' }))
    insert.mockResolvedValueOnce({ error: { code: '23505' } })
    await expect(deps.audit(event)).rejects.toThrow('já foi utilizado')
    insert.mockResolvedValueOnce({ error: { code: '503', message: 'private-detail' } })
    await expect(deps.audit(event)).rejects.toThrow('registrar')
    await deps.audit({ ...event, event: 'prepared' })
    expect(insert.mock.calls.at(-1)![0]).not.toHaveProperty('id')
    verifyIdentity.mockResolvedValue('revoked')
    await expect(deps.audit(event)).rejects.toThrow('Dispositivo')
  })
})
