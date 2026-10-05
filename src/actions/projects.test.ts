import { createClient } from '@supabase/supabase-js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GITHUB_OAUTH_SCOPES } from '@/lib/github/scopes'

const mocks = vi.hoisted(() => ({ client: vi.fn(), token: vi.fn(), owners: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: mocks.client }))
vi.mock('@/lib/account-tokens/server', () => ({ getAccountToken: mocks.token }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/preview', () => ({ sharedPreviewConfig: () => null, deleteSharedPreview: vi.fn() }))
vi.mock('@/lib/github/owners', async (original) => ({
  ...await original<typeof import('@/lib/github/owners')>(), getSelectableOwners: mocks.owners,
}))
import { createEmptyProject, deleteProject, getOwnerChoices } from './projects'

const projectId = '11111111-1111-4111-8111-111111111111'
const ownerId = 'owner-session'

function database(options: { projectOwner?: string; accountOwner?: string; signedIn?: boolean } = {}) {
  const rows: Record<string, Record<string, unknown>> = {
    projects: { id: projectId, user_id: options.projectOwner ?? ownerId, name: 'app', github_account_id: 'github-account', github_repo_full_name: 'owner/app', supabase_account_id: 'supabase-account', supabase_project_ref: 'app-ref' },
    github_accounts: { id: 'github-account', user_id: options.accountOwner ?? ownerId, login: 'owner', scopes: [...GITHUB_OAUTH_SCOPES] },
    supabase_accounts: { id: 'supabase-account', user_id: options.accountOwner ?? ownerId },
  }
  const reads: URL[] = []
  const writes: URL[] = []
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    if (init?.method && init.method !== 'GET') {
      writes.push(url)
      return init.method === 'POST' && url.pathname.endsWith('/projects')
        ? Response.json({ id: projectId }) : new Response(null, { status: 204 })
    }
    reads.push(url)
    const row = rows[url.pathname.split('/').at(-1) ?? '']
    const found = row && ['id', 'user_id'].every(column => !url.searchParams.has(column) || url.searchParams.get(column) === `eq.${String(row[column])}`)
    return Response.json(found ? row : null)
  }
  const client = createClient('https://supabase.example.test', 'fixture-key', {
    global: { fetch: fetcher }, auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })
  mocks.client.mockResolvedValue({
    from: client.from.bind(client),
    auth: { getUser: async () => ({ data: { user: options.signedIn === false ? null : { id: ownerId } } }) },
  })
  return { reads, writes }
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.token.mockImplementation(async ({ provider }: { provider: string }) => `renewed-${provider}-token`)
  mocks.owners.mockResolvedValue([{ login: 'owner', type: 'personal' }, { login: 'team', type: 'organization' }])
})
afterEach(() => vi.unstubAllGlobals())

describe('project operations resolve renewable owner-scoped provider tokens', () => {
  it('deletes external resources using both renewed provider tokens', async () => {
    const store = database()
    const request = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', request)
    expect(await deleteProject(projectId)).toEqual({})
    for (const provider of ['github', 'supabase']) {
      expect(mocks.token).toHaveBeenCalledWith({ provider, accountId: `${provider}-account`, userId: ownerId })
      expect(request).toHaveBeenCalledWith(expect.stringContaining(`api.${provider}.com`), expect.objectContaining({
        method: 'DELETE', headers: expect.objectContaining({ Authorization: `Bearer renewed-${provider}-token` }),
      }))
    }
    expect(store.reads.every(url => url.searchParams.get('user_id') === `eq.${ownerId}`)).toBe(true)
    expect(store.reads.slice(1).every(url => !url.searchParams.get('select')?.includes('token'))).toBe(true)
  })

  it('does not access accounts or delete resources belonging to another project owner', async () => {
    const store = database({ projectOwner: 'another-owner' })
    const request = vi.fn()
    vi.stubGlobal('fetch', request)
    expect(await deleteProject(projectId)).toEqual({ error: 'Projeto não encontrado.' })
    expect(store.reads).toHaveLength(1)
    expect(store.writes).toHaveLength(0)
    expect(mocks.token).not.toHaveBeenCalled()
    expect(request).not.toHaveBeenCalled()
  })

  it('does not use foreign account records even when referenced by an owned project', async () => {
    database({ accountOwner: 'another-owner' })
    const request = vi.fn()
    vi.stubGlobal('fetch', request)
    await deleteProject(projectId)
    expect(mocks.token).not.toHaveBeenCalled()
    expect(request).not.toHaveBeenCalled()
  })

  it('keeps local deletion possible if provider token renewal fails', async () => {
    const store = database()
    mocks.token.mockRejectedValue(new Error('Reconecte sua conta.'))
    const request = vi.fn()
    vi.stubGlobal('fetch', request)
    expect((await deleteProject(projectId)).warnings).toHaveLength(2)
    expect(store.writes.some(url => url.pathname.endsWith('/projects'))).toBe(true)
    expect(request).not.toHaveBeenCalled()
  })

  it.each([
    { name: 'owner choices', run: getOwnerChoices },
    { name: 'project creation owner authorization', run: () => createEmptyProject('app', '', 'solo', 'team') },
  ])('renews before $name without loading encrypted columns', async ({ run }) => {
    const store = database()
    await run()
    expect(mocks.token).toHaveBeenCalledExactlyOnceWith({ provider: 'github', accountId: 'github-account', userId: ownerId })
    expect(mocks.owners).toHaveBeenCalledExactlyOnceWith('renewed-github-token', 'owner')
    expect(store.reads[0]?.searchParams.get('user_id')).toBe(`eq.${ownerId}`)
    expect(store.reads[0]?.searchParams.get('select')).not.toContain('token')
  })

  it('continues to reject a requested organization outside the authenticated owner set', async () => {
    const store = database()
    expect(await createEmptyProject('app', '', 'solo', 'foreign-team')).toEqual({ error: 'Owner não autorizado para o seu usuário.' })
    expect(mocks.token).toHaveBeenCalledWith({ provider: 'github', accountId: 'github-account', userId: ownerId })
    expect(store.writes).toHaveLength(0)
  })

  it('does not resolve credentials without a user session', async () => {
    database({ signedIn: false })
    expect(await deleteProject(projectId)).toEqual({ error: 'Não autorizado.' })
    expect(await getOwnerChoices()).toEqual({ owners: [], needsReconnect: false, notConnected: true })
    expect(await createEmptyProject('app', '', 'solo', 'team')).toEqual({ error: 'Não autorizado.' })
    expect(mocks.token).not.toHaveBeenCalled()
  })
})
