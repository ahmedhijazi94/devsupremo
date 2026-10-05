import { createClient } from '@supabase/supabase-js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StepDef } from './engine'

const mocks = vi.hoisted(() => ({ token: vi.fn(), installation: vi.fn(), appToken: vi.fn(), engine: vi.fn() }))
vi.mock('@/lib/account-tokens/server', () => ({ getAccountToken: mocks.token }))
vi.mock('@/lib/github/app', () => ({ findInstallationForAccount: mocks.installation, appInstallationToken: mocks.appToken }))
vi.mock('@/lib/provisioning/engine', () => ({ runProvisioning: mocks.engine }))
import { provisionProject, provisionSupabase } from './provision'

const projectId = '11111111-1111-4111-8111-111111111111'
const ownerId = 'owner-session'
const project = {
  id: projectId, user_id: ownerId, name: 'app', kind: 'public',
  github_account_id: 'github-account', github_owner_type: 'personal',
  github_owner_login: 'owner', provisioning_state: 'draft',
}

function database(overrides: Record<string, Record<string, unknown>> = {}) {
  const rows: Record<string, Record<string, unknown>> = {
    projects: { ...project },
    github_accounts: { id: 'github-account', user_id: ownerId, login: 'owner' },
    supabase_accounts: { id: 'supabase-account', user_id: ownerId, org_slug: 'org' },
    ...overrides,
  }
  const reads: URL[] = []
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    reads.push(url)
    const row = rows[url.pathname.split('/').at(-1) ?? '']
    const found = row && ['id', 'user_id'].every(column => !url.searchParams.has(column) || url.searchParams.get(column) === `eq.${String(row[column])}`)
    return Response.json(found ? row : null)
  }
  const client = createClient('https://supabase.example.test', 'fixture-key', {
    global: { fetch: fetcher }, auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })
  return { client, reads }
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.token.mockResolvedValue('renewed-oauth-token')
  mocks.installation.mockResolvedValue({ id: 42 })
  mocks.appToken.mockResolvedValue('installation-token')
  // Exercise the actual repository-creation step; the remaining provisioning
  // steps are unrelated to selecting OAuth versus the App's credentials.
  mocks.engine.mockImplementation(async (steps: StepDef<Record<string, unknown>>[]) => {
    await steps[0]!.run({}, async () => {})
    return { ok: true }
  })
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('provisioning account token boundaries', () => {
  it.each([
    { type: 'personal', token: 'renewed-oauth-token', path: '/user/repos' },
    { type: 'organization', token: 'installation-token', path: '/orgs/team/repos' },
  ])('uses the correct token for $type repository provisioning', async ({ type, token, path }) => {
    const store = database({ projects: { ...project, github_owner_type: type, github_owner_login: type === 'organization' ? 'team' : 'owner' } })
    const request = vi.fn(async (url: string) => url.endsWith('/repos')
      ? Response.json({ id: 42, full_name: 'owner/app', default_branch: 'main' })
      : Response.json({ object: { sha: 'a'.repeat(40) } }))
    vi.stubGlobal('fetch', request)
    if (type === 'organization') mocks.token.mockRejectedValue(new Error('OAuth session expired'))

    expect(await provisionProject({ projectId, userId: ownerId, supabase: store.client })).toEqual({})
    expect(request).toHaveBeenCalledWith(`https://api.github.com${path}`, expect.objectContaining({
      method: 'POST', headers: expect.objectContaining({ Authorization: `Bearer ${token}` }),
    }))
    if (type === 'personal') {
      expect(mocks.token).toHaveBeenCalledExactlyOnceWith({ provider: 'github', accountId: 'github-account', userId: ownerId })
      expect(mocks.appToken).not.toHaveBeenCalled()
    } else {
      expect(mocks.appToken).toHaveBeenCalledExactlyOnceWith(42)
      expect(mocks.token).not.toHaveBeenCalled()
    }
    expect(store.reads[1]?.searchParams.get('select')).toBe('login')
    expect(store.reads.every(url => url.searchParams.get('user_id') === `eq.${ownerId}`)).toBe(true)
  })

  it.each(['projects', 'github_accounts'])('rejects a foreign %s row before obtaining tokens or creating resources', async (table) => {
    const row = table === 'projects' ? project : { id: 'github-account', login: 'owner' }
    const store = database({ [table]: { ...row, user_id: 'another-owner' } })
    const request = vi.fn()
    vi.stubGlobal('fetch', request)
    expect((await provisionProject({ projectId, userId: ownerId, supabase: store.client })).error).toBeTruthy()
    expect(mocks.token).not.toHaveBeenCalled()
    expect(mocks.appToken).not.toHaveBeenCalled()
    expect(request).not.toHaveBeenCalled()
  })

  it('uses the renewed Supabase token for readiness checks and migrations', async () => {
    vi.useFakeTimers()
    const store = database()
    const request = vi.fn(async () => Response.json({ status: 'ACTIVE_HEALTHY' }))
    vi.stubGlobal('fetch', request)
    const pending = provisionSupabase(store.client, ownerId, 'supabase-account', 'app', 'solo', {
      existingRef: 'development-ref', verifyDevelopment: async () => {},
    })
    await vi.advanceTimersByTimeAsync(5000)
    expect((await pending).projectRef).toBe('development-ref')
    expect(mocks.token).toHaveBeenCalledExactlyOnceWith({ provider: 'supabase', accountId: 'supabase-account', userId: ownerId })
    expect(store.reads[0]?.searchParams.get('select')).toBe('org_slug')
    for (const call of request.mock.calls as unknown as Array<[string, RequestInit]>) {
      expect(call[1].headers).toMatchObject({ Authorization: 'Bearer renewed-oauth-token' })
    }
  })

  it('rejects a foreign Supabase account before renewal or provider access', async () => {
    const store = database({ supabase_accounts: { id: 'supabase-account', user_id: 'another-owner', org_slug: 'org' } })
    const request = vi.fn()
    vi.stubGlobal('fetch', request)
    await expect(provisionSupabase(store.client, ownerId, 'supabase-account', 'app', 'solo')).rejects.toThrow('Conta Supabase não encontrada')
    expect(mocks.token).not.toHaveBeenCalled()
    expect(request).not.toHaveBeenCalled()
  })
})
