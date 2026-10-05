import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { decryptToken } from '@/lib/crypto'

const mocks = vi.hoisted(() => ({ createClient: vi.fn(), consumeOAuthState: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: mocks.createClient }))
vi.mock('@/lib/oauth-state', () => ({ consumeOAuthState: mocks.consumeOAuthState }))
vi.mock('next/navigation', () => ({ redirect: (url: string) => { throw new Error(`redirect:${url}`) } }))

import { GET } from './route'

const fetchMock = vi.fn<typeof fetch>()
const upsert = vi.fn()
const getUser = vi.fn()
const request = () => new Request('https://supremo.test/auth/supabase-account/callback?code=authorization-code&state=one-time-state')

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
  mocks.createClient.mockResolvedValue({ auth: { getUser }, from: () => account })
  mocks.consumeOAuthState.mockResolvedValue({ projectId: null })
  fetchMock.mockResolvedValueOnce(Response.json({ access_token: 'new-access-token', refresh_token: 'new-refresh-token', expires_in: 3600 }))
    .mockResolvedValueOnce(Response.json([{ id: 'org-id', name: 'My organization' }]))
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('Supabase OAuth reconnect', () => {
  it('replaces the credentials and clears a refresh claim from before reconnect', async () => {
    await expect(GET(request())).rejects.toThrow('redirect:/projects?success=supabase_connected')
    const saved = upsert.mock.calls[0]?.[0] as Record<string, unknown>
    expect(saved).toMatchObject({
      user_id: 'owner-id', org_slug: 'org-id',
      token_expires_at: '2026-01-01T01:00:00.000Z',
      token_refresh_claim: null, token_refresh_started_at: null,
    })
    expect(decryptToken(saved.access_token_encrypted as string)).toBe('new-access-token')
    expect(decryptToken(saved.refresh_token_encrypted as string)).toBe('new-refresh-token')
    expect(upsert).toHaveBeenCalledWith(expect.any(Object), { onConflict: 'user_id,org_slug' })
    expect(mocks.consumeOAuthState).toHaveBeenCalledWith(expect.any(Object), 'owner-id', 'supabase', 'one-time-state')
  })

  it('does not retain previous OAuth refresh data if the new response has none', async () => {
    fetchMock.mockReset()
      .mockResolvedValueOnce(Response.json({ access_token: 'new-access-token' }))
      .mockResolvedValueOnce(Response.json([{ id: 'org-id', name: 'My organization' }]))
    await expect(GET(request())).rejects.toThrow('redirect:/projects?success=supabase_connected')
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      refresh_token_encrypted: null, token_expires_at: null,
      token_refresh_claim: null, token_refresh_started_at: null,
    }), expect.any(Object))
  })

  it('rejects invalid OAuth state before exchanging or saving credentials', async () => {
    mocks.consumeOAuthState.mockResolvedValue(null)
    await expect(GET(request())).rejects.toThrow('redirect:/projects?error=invalid_state')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(upsert).not.toHaveBeenCalled()
  })

  it('requires authentication before consuming the callback state', async () => {
    getUser.mockResolvedValue({ data: { user: null } })
    await expect(GET(request())).rejects.toThrow('redirect:/login')
    expect(mocks.consumeOAuthState).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('never logs a failed exchange response containing credential material', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    fetchMock.mockReset().mockResolvedValueOnce(Response.json({ access_token: 'secret-access-token', refresh_token: 'secret-refresh-token' }, { status: 400 }))
    await expect(GET(request())).rejects.toThrow('redirect:/projects?error=auth_failed')
    expect(upsert).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith('Supabase OAuth token exchange failed')
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret-')
  })
})
