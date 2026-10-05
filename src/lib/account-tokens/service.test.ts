import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { decryptToken, encryptToken } from '../crypto'
import { resolveAccountToken, type AccountTokenPort, type AccountTokenRow } from './service'
import { type AccountProvider, type AccountTokenValues } from './provider'

const HOUR = 3_600_000
function fixture(provider: AccountProvider = 'github') {
  let row: AccountTokenRow | null = {
    access_token_encrypted: encryptToken('old-access'), refresh_token_encrypted: encryptToken('old-refresh'),
    token_expires_at: new Date(Date.now() - 30 * 24 * HOUR).toISOString(),
    token_refresh_claim: null, token_refresh_started_at: null,
  }
  const read = vi.fn(async () => row && { ...row })
  const claim = vi.fn(async (expected: string, id: string) => {
    if (!row || row.access_token_encrypted !== expected || row.token_refresh_claim) return false
    row = { ...row, token_refresh_claim: id, token_refresh_started_at: new Date().toISOString() }
    return true
  })
  const finish = vi.fn(async (expected: string, id: string, update: AccountTokenValues) => {
    if (!row || row.access_token_encrypted !== expected || row.token_refresh_claim !== id) return false
    row = { ...update, token_refresh_claim: null, token_refresh_started_at: null }
    return true
  })
  const port: AccountTokenPort = { provider, read, claim, finish, sleep: async () => { await new Promise(resolve => setTimeout(resolve, 0)) } }
  return { port, read, claim, finish, get row() { return row }, set row(next) { row = next } }
}

function providerReply(body: unknown = { access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 }, status = 200) {
  const fetch = vi.fn(async () => new Response(JSON.stringify(body), { status }))
  vi.stubGlobal('fetch', fetch)
  return fetch
}

beforeEach(() => {
  vi.stubEnv('ENCRYPTION_KEY', 'c'.repeat(64))
  vi.stubEnv('GITHUB_CLIENT_ID', 'github-id')
  vi.stubEnv('GITHUB_CLIENT_SECRET', 'github-secret')
  vi.stubEnv('SUPABASE_OAUTH_CLIENT_ID', 'supabase-id')
  vi.stubEnv('SUPABASE_OAUTH_CLIENT_SECRET', 'supabase-secret')
})
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })

describe.each(['github', 'supabase'] as const)('%s account resume', provider => {
  it('renews after a month and reuses the encrypted durable result on later calls', async () => {
    const state = fixture(provider), fetch = providerReply()
    expect(await resolveAccountToken(state.port)).toBe('new-access')
    expect(await resolveAccountToken(state.port)).toBe('new-access')
    expect(fetch).toHaveBeenCalledOnce()
    expect(state.finish).toHaveBeenCalledOnce()
    expect(state.row?.access_token_encrypted).not.toContain('new-access')
    expect(decryptToken(state.row!.refresh_token_encrypted!)).toBe('new-refresh')
    expect(state.row?.token_refresh_claim).toBeNull()
  })

  it('serializes independent concurrent callers without replaying the rotating token', async () => {
    const state = fixture(provider), fetch = providerReply()
    const results = await Promise.all(Array.from({ length: 12 }, () => resolveAccountToken({ ...state.port })))
    expect(results).toEqual(Array(12).fill('new-access'))
    expect(fetch).toHaveBeenCalledOnce()
    expect(state.finish).toHaveBeenCalledOnce()
  })

  it('supports a PAT/classic token without inventing an expiration or refresh', async () => {
    const state = fixture(provider), fetch = providerReply()
    state.row = { ...state.row!, refresh_token_encrypted: null, token_expires_at: null }
    expect(await resolveAccountToken(state.port)).toBe('old-access')
    expect(fetch).not.toHaveBeenCalled()
    expect(state.claim).not.toHaveBeenCalled()
  })

  it('does not return a known-expired token without a refresh credential', async () => {
    const state = fixture(provider), fetch = providerReply()
    state.row = { ...state.row!, refresh_token_encrypted: null }
    await expect(resolveAccountToken(state.port)).rejects.toMatchObject({ code: 'reconnect_required' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('does not reserve a rotation when the server configuration is missing', async () => {
    vi.stubEnv(provider === 'github' ? 'GITHUB_CLIENT_SECRET' : 'SUPABASE_OAUTH_CLIENT_SECRET', '')
    const state = fixture(provider), fetch = providerReply()
    await expect(resolveAccountToken(state.port)).rejects.toMatchObject({ code: 'unavailable' })
    expect(state.claim).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('never reflects provider errors or credentials into user-visible diagnostics', async () => {
    const state = fixture(provider)
    providerReply({ error: 'invalid_grant', error_description: 'old-refresh github-secret private-account' }, 400)
    const error = await resolveAccountToken(state.port).catch(value => value as Error)
    expect(error).toMatchObject({ code: 'reconnect_required' })
    expect(String(error)).not.toMatch(/old-refresh|github-secret|private-account/)
  })
})

it('retries only persistence after a temporary save failure; never refreshes twice', async () => {
  const state = fixture(), fetch = providerReply()
  state.finish.mockRejectedValueOnce(new Error('db unavailable with private details'))
  expect(await resolveAccountToken(state.port)).toBe('new-access')
  expect(state.finish).toHaveBeenCalledTimes(2)
  expect(fetch).toHaveBeenCalledOnce()
})

it('recognizes a committed rotation whose acknowledgement was lost', async () => {
  const state = fixture(), fetch = providerReply()
  state.finish.mockImplementationOnce(async (_expected, _id, update) => {
    state.row = { ...update, token_expires_at: update.token_expires_at!.replace('Z', '+00:00'), token_refresh_claim: null, token_refresh_started_at: null }
    throw new Error('ack lost')
  })
  expect(await resolveAccountToken(state.port)).toBe('new-access')
  expect(state.finish).toHaveBeenCalledOnce()
  expect(fetch).toHaveBeenCalledOnce()
})

it('never reports a usable new token when its persistence was not confirmed', async () => {
  const state = fixture(), fetch = providerReply()
  state.finish.mockResolvedValue(false)
  await expect(resolveAccountToken(state.port)).rejects.toMatchObject({ code: 'unavailable' })
  expect(state.finish).toHaveBeenCalledTimes(2)
  expect(fetch).toHaveBeenCalledOnce()
  expect(state.row?.token_refresh_claim).not.toBeNull()
})

it('preserves an owner reconnection while the old refresh response is in flight', async () => {
  const state = fixture()
  providerReply()
  state.finish.mockImplementationOnce(async () => {
    state.row = { ...state.row!, access_token_encrypted: encryptToken('owner-new-pat'), refresh_token_encrypted: null, token_expires_at: null, token_refresh_claim: null, token_refresh_started_at: null }
    return false
  })
  expect(await resolveAccountToken(state.port)).toBe('owner-new-pat')
  expect(decryptToken(state.row!.access_token_encrypted)).toBe('owner-new-pat')
})

it('does not contact the provider if the account is disconnected after acquiring the claim', async () => {
  const state = fixture(), fetch = providerReply()
  state.claim.mockImplementationOnce(async () => { state.row = null; return true })
  await expect(resolveAccountToken(state.port)).rejects.toMatchObject({ code: 'reconnect_required' })
  expect(fetch).not.toHaveBeenCalled()
})

it('does not contact the old provider authorization if the owner reconnects before rotation', async () => {
  const state = fixture(), fetch = providerReply()
  state.claim.mockImplementationOnce(async () => {
    state.row = { ...state.row!, access_token_encrypted: encryptToken('reconnected'), refresh_token_encrypted: null, token_expires_at: null }
    return true
  })
  expect(await resolveAccountToken(state.port)).toBe('reconnected')
  expect(fetch).not.toHaveBeenCalled()
})

it('clears a known-unused reservation when reading it fails before remote dispatch', async () => {
  const state = fixture(), fetch = providerReply()
  state.read.mockResolvedValueOnce({ ...state.row! }).mockRejectedValueOnce(new Error('storage temporarily unavailable'))
  await expect(resolveAccountToken(state.port)).rejects.toMatchObject({ code: 'unavailable' })
  expect(state.row?.token_refresh_claim).toBeNull()
  expect(fetch).not.toHaveBeenCalled()
  expect(await resolveAccountToken(state.port)).toBe('new-access')
  expect(fetch).toHaveBeenCalledOnce()
})

it('clears an unused committed reservation after its acknowledgement is lost', async () => {
  const state = fixture(), fetch = providerReply()
  state.claim.mockImplementationOnce(async (_expected, id) => {
    state.row = { ...state.row!, token_refresh_claim: id, token_refresh_started_at: new Date().toISOString() }
    throw new Error('ack lost')
  })
  await expect(resolveAccountToken(state.port)).rejects.toMatchObject({ code: 'unavailable' })
  expect(state.row?.token_refresh_claim).toBeNull()
  expect(fetch).not.toHaveBeenCalled()
  expect(await resolveAccountToken(state.port)).toBe('new-access')
})

it('keeps a safe explicit failure when releasing an unused claim cannot be confirmed', async () => {
  const state = fixture(), fetch = providerReply()
  state.read.mockResolvedValueOnce({ ...state.row! }).mockRejectedValueOnce(new Error('storage unavailable'))
  state.finish.mockRejectedValue(new Error('secret details'))
  const error = await resolveAccountToken(state.port).catch(value => value as Error)
  expect(error).toMatchObject({ code: 'unavailable' })
  expect(String(error)).not.toContain('secret details')
  expect(fetch).not.toHaveBeenCalled()
})

it('does not use the old result after reconnection requires its own rotation', async () => {
  const state = fixture()
  providerReply()
  state.finish.mockImplementationOnce(async () => {
    state.row = { ...state.row!, access_token_encrypted: encryptToken('owner-new-oauth'), token_refresh_claim: null, token_refresh_started_at: null }
    return false
  })
  await expect(resolveAccountToken(state.port)).rejects.toMatchObject({ code: 'refresh_pending' })
})

it('rejects unusable classic credentials without calling a provider', async () => {
  const state = fixture(), fetch = providerReply()
  state.row = { ...state.row!, access_token_encrypted: 'broken', refresh_token_encrypted: null, token_expires_at: null }
  await expect(resolveAccountToken(state.port)).rejects.toMatchObject({ code: 'reconnect_required' })
  expect(fetch).not.toHaveBeenCalled()
})

it('does not blame owner authorization for an OAuth client configuration error', async () => {
  const state = fixture()
  providerReply({ error: 'incorrect_client_credentials', error_description: 'private-client' }, 400)
  await expect(resolveAccountToken(state.port)).rejects.toMatchObject({ code: 'unavailable' })
  expect(state.row?.token_refresh_claim).toBeNull()
  providerReply()
  expect(await resolveAccountToken(state.port)).toBe('new-access')
})

it('rejects invalid JSON and does not persist it', async () => {
  const state = fixture()
  vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>error</html>', { status: 200 })))
  await expect(resolveAccountToken(state.port)).rejects.toMatchObject({ code: 'unavailable' })
  expect(state.finish).not.toHaveBeenCalled()
})

it('returns pending promptly rather than duplicating a slow active rotation', async () => {
  const state = fixture(), fetch = providerReply()
  state.row = { ...state.row!, token_refresh_claim: 'another-worker', token_refresh_started_at: new Date().toISOString() }
  state.port.sleep = async () => {}
  await expect(resolveAccountToken(state.port)).rejects.toMatchObject({ code: 'refresh_pending' })
  expect(fetch).not.toHaveBeenCalled()
})

it.each(['2020-01-01T00:00:00Z', 'invalid', null])('never replays an abandoned or unverifiable rotation (%s)', async started => {
  const state = fixture(), fetch = providerReply()
  state.row = { ...state.row!, token_refresh_claim: 'abandoned', token_refresh_started_at: started }
  await expect(resolveAccountToken(state.port)).rejects.toMatchObject({ code: 'reconnect_required' })
  expect(fetch).not.toHaveBeenCalled()
})

it.each(['read', 'claim'] as const)('sanitizes storage %s failures', async step => {
  const state = fixture(), fetch = providerReply()
  state[step].mockRejectedValueOnce(new Error('sensitive database detail'))
  const error = await resolveAccountToken(state.port).catch(value => value as Error)
  expect(error).toMatchObject({ code: 'unavailable' })
  expect(String(error)).not.toContain('sensitive')
  expect(fetch).not.toHaveBeenCalled()
})

it('sanitizes invalid encrypted credentials before reserving rotation', async () => {
  const state = fixture(), fetch = providerReply()
  state.row = { ...state.row!, refresh_token_encrypted: 'not-an-encrypted-token' }
  await expect(resolveAccountToken(state.port)).rejects.toMatchObject({ code: 'reconnect_required' })
  expect(state.claim).not.toHaveBeenCalled()
  expect(fetch).not.toHaveBeenCalled()
})

it('holds the claim if the network result is unknown, preventing a second token exchange', async () => {
  const state = fixture()
  const fetch = vi.fn().mockRejectedValue(new Error('network lost'))
  vi.stubGlobal('fetch', fetch)
  await expect(resolveAccountToken(state.port)).rejects.toMatchObject({ code: 'unavailable' })
  state.port.sleep = async () => {}
  await expect(resolveAccountToken(state.port)).rejects.toMatchObject({ code: 'refresh_pending' })
  expect(fetch).toHaveBeenCalledOnce()
})

it.each([
  { access_token: 'new', expires_in: -1 },
  { access_token: 'new' },
  { access_token: 'invalid token', expires_in: 3600 },
  { access_token: 'new', expires_in: 3600, token_type: 'basic' },
  { access_token: 'new', expires_in: 3600, extra: 'x'.repeat(49_000) },
])('does not persist an invalid or oversized provider response', async body => {
  const state = fixture()
  providerReply(body)
  await expect(resolveAccountToken(state.port)).rejects.toMatchObject({ code: 'unavailable' })
  expect(state.finish).not.toHaveBeenCalled()
})

it('sanitizes provider non-authentication failures', async () => {
  const state = fixture()
  providerReply({ error: 'server_error', error_description: 'secret' }, 503)
  await expect(resolveAccountToken(state.port)).rejects.toMatchObject({ code: 'unavailable' })
})
