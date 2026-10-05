import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { decryptToken } from '@/lib/crypto'

const mocks = vi.hoisted(() => ({ createClient: vi.fn(), consumeOAuthState: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: mocks.createClient }))
vi.mock('@/lib/oauth-state', () => ({ consumeOAuthState: mocks.consumeOAuthState }))
vi.mock('next/navigation', () => ({ redirect: (url: string) => { throw new Error(`redirect:${url}`) } }))

import { GET } from './route'

const fetchMock = vi.fn<typeof fetch>()
const upsert = vi.fn()
const getUser = vi.fn()
const request = () => new NextRequest('https://supremo.test/auth/github-account/callback?code=authorization-code&state=one-time-state')

beforeEach(() => {
  vi.clearAllMocks()
  fetchMock.mockReset()
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  const account = {
    upsert,
    select: vi.fn(() => account),
    single: vi.fn(async () => ({ data: { id: 'account-id' }, error: null })),
  }
  upsert.mockReturnValue(account)
  getUser.mockResolvedValue({ data: { user: { id: 'owner-id' } } })
  mocks.createClient.mockResolvedValue({
    auth: { getUser },
    from: (table: string) => table === 'github_accounts' ? account : { insert: vi.fn() },
  })
  mocks.consumeOAuthState.mockResolvedValue({ projectId: null })
  fetchMock.mockResolvedValueOnce(Response.json({ access_token: 'new-access-token', refresh_token: 'new-refresh-token', expires_in: 3600, scope: 'repo,read:org' }))
    .mockResolvedValueOnce(Response.json({ id: 123, login: 'octocat', name: null, avatar_url: 'https://github.test/avatar' }))
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('GitHub account reconnect', () => {
  it('saves the new token pair and clears any previous refresh claim', async () => {
    await expect(GET(request())).rejects.toThrow('redirect:/accounts?success=github_connected')
    const saved = upsert.mock.calls[0]?.[0] as Record<string, unknown>
    expect(saved).toMatchObject({
      user_id: 'owner-id', github_user_id: 123,
      token_expires_at: '2026-01-01T01:00:00.000Z',
      token_refresh_claim: null, token_refresh_started_at: null,
    })
    expect(decryptToken(saved.access_token_encrypted as string)).toBe('new-access-token')
    expect(decryptToken(saved.refresh_token_encrypted as string)).toBe('new-refresh-token')
    expect(mocks.consumeOAuthState).toHaveBeenCalledWith(expect.any(Object), 'owner-id', 'github', 'one-time-state')
  })

  it('clears prior refresh credentials when reconnect returns a classic non-expiring token', async () => {
    fetchMock.mockReset()
      .mockResolvedValueOnce(Response.json({ access_token: 'classic-token' }))
      .mockResolvedValueOnce(Response.json({ id: 123, login: 'octocat', name: null, avatar_url: null }))
    await expect(GET(request())).rejects.toThrow('redirect:/accounts?success=github_connected')
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      refresh_token_encrypted: null, token_expires_at: null,
      token_refresh_claim: null, token_refresh_started_at: null,
    }), { onConflict: 'user_id,github_user_id' })
  })

  it('rejects reused or invalid OAuth state before exchanging or saving credentials', async () => {
    mocks.consumeOAuthState.mockResolvedValue(null)
    await expect(GET(request())).rejects.toThrow('redirect:/accounts?error=invalid_state')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(upsert).not.toHaveBeenCalled()
  })

  it('requires an authenticated user before consuming the callback state', async () => {
    getUser.mockResolvedValue({ data: { user: null } })
    await expect(GET(request())).rejects.toThrow('redirect:/login')
    expect(mocks.consumeOAuthState).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
