import { describe, it, expect, vi } from 'vitest'
import { authorizeBackend, type BackendAuthority, type OwnedBackendProject } from './authorization'

function fixture() {
  const project = { supabase_project_ref: 'projectref', supabase_account_id: 'account' }
  const env = { project_ref: 'projectref', environment: 'development', source: 'supremo_provisioned' }
  const authority: BackendAuthority<OwnedBackendProject> = { ownerId: 'owner', identity: vi.fn(async () => 'owner'),
    project: vi.fn(async () => ({ ...project })), environment: vi.fn(async () => ({ ...env })),
    credentials: vi.fn(async () => ({ projectRef: 'projectref', token: 'private-token' })) }
  return { authority, project, env }
}
describe('backend console authority', () => {
  it('reauthorizes the owner before and after token resolution', async () => {
    const { authority } = fixture(), session = await authorizeBackend(authority)
    expect(await session.resolve()).toEqual({ projectRef: 'projectref', token: 'private-token' })
    expect(authority.identity).toHaveBeenCalledTimes(3)
    expect(authority.project).toHaveBeenCalledWith('owner')
  })
  it.each(['identity', 'account', 'ref', 'environment'])('rejects %s changes without resolving credentials', async change => {
    const { authority, project, env } = fixture(), session = await authorizeBackend(authority)
    if (change === 'identity') authority.identity = async () => 'another'
    if (change === 'account') project.supabase_account_id = 'another'
    if (change === 'ref') project.supabase_project_ref = 'another'
    if (change === 'environment') env.environment = 'production'
    await expect(session.resolve()).rejects.toThrow()
    expect(authority.credentials).not.toHaveBeenCalled()
  })
  it('rejects reassignment during credential refresh', async () => {
    const { authority, project } = fixture(), session = await authorizeBackend(authority)
    authority.credentials = async () => { project.supabase_account_id = 'another'; return { projectRef: 'projectref', token: 'private' } }
    await expect(session.resolve()).rejects.toThrow('mudou')
  })
  it('rejects a credential response for another project', async () => {
    const { authority } = fixture(), session = await authorizeBackend(authority)
    authority.credentials = async () => ({ projectRef: 'other', token: 'private' })
    await expect(session.resolve()).rejects.toThrow('vínculo')
  })
  it('allows owner reads but refuses mutations in an unclassified environment', async () => {
    const { authority } = fixture(); authority.environment = async () => null
    const session = await authorizeBackend(authority)
    expect(session.target.environment).toBe('unknown')
    await expect(session.resolve(true)).resolves.toBeDefined()
    await expect(session.resolve(false)).rejects.toThrow('confirmado')
  })
  it('does not connect to invalid or missing projects', async () => {
    for (const ref of [null, 'https://external.example', '']) {
      const { authority, project } = fixture()
      authority.project = async () => ({ ...project, supabase_project_ref: ref })
      await expect(authorizeBackend(authority)).rejects.toThrow('Conecte')
    }
    const { authority } = fixture(); authority.project = async () => { throw new Error('Denied') }
    await expect(authorizeBackend(authority)).rejects.toThrow('Denied')
    expect(authority.credentials).not.toHaveBeenCalled()
  })
})
