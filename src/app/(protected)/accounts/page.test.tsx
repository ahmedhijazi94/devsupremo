import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(), checkConnectedAccount: vi.fn(), isSupabaseOAuthAvailable: vi.fn(),
}))
vi.mock('@/lib/supabase/server', () => ({ createClient: mocks.createClient }))
vi.mock('@/lib/account-health/server', () => ({ checkConnectedAccount: mocks.checkConnectedAccount }))
vi.mock('@/actions/accounts', () => ({ isSupabaseOAuthAvailable: mocks.isSupabaseOAuthAvailable }))
vi.mock('next/navigation', () => ({ redirect: (url: string) => { throw new Error(`redirect:${url}`) } }))
vi.mock('@/components/accounts/connect-github-button', () => ({ ConnectGithubButton: () => null }))
vi.mock('@/components/accounts/connect-supabase-button', () => ({ ConnectSupabaseButton: () => null }))
vi.mock('@/components/accounts/disconnect-account-button', () => ({ DisconnectAccountButton: () => null }))
vi.mock('@/components/accounts/reconnect-button', () => ({ ReconnectButton: () => null }))
vi.mock('@/components/accounts/accounts-toast-handler', () => ({ AccountsToastHandler: () => null }))

import AccountsPage from './page'

const select = vi.fn()
const eq = vi.fn()
const from = vi.fn()
const getUser = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  const rows: Record<string, Array<Record<string, unknown>>> = {
    github_accounts: [{ id: 'github-account', login: 'octocat', name: null, avatar_url: null, scopes: ['repo'], created_at: '2026-01-01T00:00:00Z' }],
    supabase_accounts: [{ id: 'supabase-account', org_name: 'My organization', created_at: '2026-01-01T00:00:00Z' }],
  }
  from.mockImplementation((table: string) => {
    const query = {
      select: (fields: string) => { select(table, fields); return query },
      eq: (column: string, value: string) => { eq(table, column, value); return query },
      order: async () => ({ data: rows[table] }),
    }
    return query
  })
  getUser.mockResolvedValue({ data: { user: { id: 'owner-id' } } })
  mocks.createClient.mockResolvedValue({ auth: { getUser }, from })
  mocks.isSupabaseOAuthAvailable.mockResolvedValue(true)
  mocks.checkConnectedAccount.mockResolvedValue('ok')
})

describe('connected accounts page', () => {
  it('loads display metadata and verifies each account using its authenticated owner', async () => {
    const html = renderToStaticMarkup(await AccountsPage({ searchParams: Promise.resolve({}) }))
    expect(select).toHaveBeenCalledWith('github_accounts', 'id,login,name,avatar_url,scopes,created_at')
    expect(select).toHaveBeenCalledWith('supabase_accounts', 'id,org_name,created_at')
    expect(eq).toHaveBeenCalledWith('github_accounts', 'user_id', 'owner-id')
    expect(eq).toHaveBeenCalledWith('supabase_accounts', 'user_id', 'owner-id')
    expect(mocks.checkConnectedAccount).toHaveBeenCalledWith('github', 'github-account', 'owner-id')
    expect(mocks.checkConnectedAccount).toHaveBeenCalledWith('supabase', 'supabase-account', 'owner-id')
    expect(html).toContain('octocat')
    expect(html).toContain('My organization')
    expect(html.match(/Conectado/g)).toHaveLength(2)
  })

  it('distinguishes a temporary refresh problem from authorization that needs reconnecting', async () => {
    mocks.checkConnectedAccount.mockResolvedValueOnce('unknown').mockResolvedValueOnce('expired')
    const html = renderToStaticMarkup(await AccountsPage({ searchParams: Promise.resolve({}) }))
    expect(html).toContain('Não foi possível verificar')
    expect(html).toContain('Autorização expirada')
    expect(html).not.toContain('Conectado')
  })

  it('redirects unauthenticated requests before loading accounts or renewing credentials', async () => {
    getUser.mockResolvedValue({ data: { user: null } })
    await expect(AccountsPage({ searchParams: Promise.resolve({}) })).rejects.toThrow('redirect:/login')
    expect(from).not.toHaveBeenCalled()
    expect(mocks.checkConnectedAccount).not.toHaveBeenCalled()
  })
})
