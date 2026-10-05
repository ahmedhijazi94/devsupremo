import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encryptToken } from '@/lib/crypto'
import { AccountTokenError } from '@/lib/account-tokens/service'

const mocks = vi.hoisted(() => ({ getAccountToken: vi.fn() }))
vi.mock('@/lib/account-tokens/server', () => ({ getAccountToken: mocks.getAccountToken }))

import { checkConnectedAccount, checkVercelToken } from './server'

const fetchMock = vi.fn<typeof fetch>()

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getAccountToken.mockResolvedValue('renewed-access-token')
  fetchMock.mockResolvedValue(new Response('{}', { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

describe('connected account health', () => {
  it.each([
    ['github', 'https://api.github.com/user'],
    ['supabase', 'https://api.supabase.com/v1/organizations'],
  ] as const)('uses the persisted, renewed %s credential for its probe', async (provider, url) => {
    expect(await checkConnectedAccount(provider, 'account-id', 'owner-id')).toBe('ok')
    expect(mocks.getAccountToken).toHaveBeenCalledWith({ provider, accountId: 'account-id', userId: 'owner-id' })
    expect(fetchMock).toHaveBeenCalledWith(url, expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer renewed-access-token' }),
      cache: 'no-store',
      signal: expect.any(AbortSignal),
    }))
  })

  it('waits for renewal persistence before asking the provider', async () => {
    let completeRenewal: (token: string) => void = () => { throw new Error('Renewal not started') }
    mocks.getAccountToken.mockReturnValue(new Promise<string>((resolve) => { completeRenewal = resolve }))
    const health = checkConnectedAccount('github', 'account-id', 'owner-id')
    expect(fetchMock).not.toHaveBeenCalled()
    completeRenewal('persisted-new-token')
    expect(await health).toBe('ok')
    expect(fetchMock).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer persisted-new-token' }),
    }))
  })

  it.each([
    ['reconnect_required', 'expired'],
    ['refresh_pending', 'unknown'],
    ['unavailable', 'unknown'],
  ] as const)('maps %s without probing an unusable old credential', async (code, health) => {
    mocks.getAccountToken.mockRejectedValue(new AccountTokenError(code))
    expect(await checkConnectedAccount('supabase', 'account-id', 'owner-id')).toBe(health)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not mistake an unexpected resolver failure for expired authorization', async () => {
    mocks.getAccountToken.mockRejectedValue(new Error('database unavailable'))
    expect(await checkConnectedAccount('github', 'account-id', 'owner-id')).toBe('unknown')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each(['github', 'supabase'] as const)('reports an unauthorized %s credential as expired', async (provider) => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 401 }))
    expect(await checkConnectedAccount(provider, 'account-id', 'owner-id')).toBe('expired')
  })

  it.each(['github', 'supabase'] as const)('keeps %s permission or rate restrictions distinct from expired authorization', async (provider) => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 403 }))
    expect(await checkConnectedAccount(provider, 'account-id', 'owner-id')).toBe('unknown')
  })

  it.each([429, 500, 503])('keeps a provider failure (%s) distinct from expired authorization', async (status) => {
    fetchMock.mockResolvedValue(new Response('{}', { status }))
    expect(await checkConnectedAccount('supabase', 'account-id', 'owner-id')).toBe('unknown')
  })

  it('handles a network timeout as unknown health', async () => {
    fetchMock.mockRejectedValue(new DOMException('Timed out', 'TimeoutError'))
    expect(await checkConnectedAccount('github', 'account-id', 'owner-id')).toBe('unknown')
  })
})

describe('Vercel health', () => {
  it.each([
    [null, 'https://api.vercel.com/v2/user'],
    ['team-id', 'https://api.vercel.com/v2/teams/team-id'],
  ])('preserves the token scope probe for %s', async (teamId, url) => {
    expect(await checkVercelToken(encryptToken('vercel-access-token'), teamId)).toBe('ok')
    expect(fetchMock).toHaveBeenCalledWith(url, expect.objectContaining({
      headers: { Authorization: 'Bearer vercel-access-token' },
    }))
    expect(mocks.getAccountToken).not.toHaveBeenCalled()
  })

  it('reports an unreadable encrypted token as expired', async () => {
    expect(await checkVercelToken('invalid-encrypted-token', null)).toBe('expired')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not mark a Vercel permission restriction as expired authorization', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 403 }))
    expect(await checkVercelToken(encryptToken('vercel-access-token'), 'team-id')).toBe('unknown')
  })
})
