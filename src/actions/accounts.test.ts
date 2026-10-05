import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { decryptToken } from '@/lib/crypto'

const mocks = vi.hoisted(() => ({ createClient: vi.fn(), revalidatePath: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: mocks.createClient }))
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }))

import { addSupabaseAccount } from './accounts'

const fetchMock = vi.fn<typeof fetch>()
const upsert = vi.fn()
const insert = vi.fn()
const from = vi.fn()
const getUser = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  const account = {
    upsert,
    select: vi.fn(() => account),
    single: vi.fn(async () => ({ data: { id: 'account-id' }, error: null })),
  }
  upsert.mockReturnValue(account)
  from.mockImplementation((table: string) => table === 'supabase_accounts' ? account : { insert })
  getUser.mockResolvedValue({ data: { user: { id: 'owner-id' } } })
  mocks.createClient.mockResolvedValue({ auth: { getUser }, from })
  fetchMock.mockResolvedValue(Response.json([{ id: 'org-id', name: 'Personal organization', slug: 'org-slug' }]))
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

describe('Supabase personal access token connection', () => {
  it('replaces OAuth credentials and clears outstanding refresh claims on reconnect', async () => {
    expect(await addSupabaseAccount({ accessToken: 'personal-access-token' })).toEqual({})
    const saved = upsert.mock.calls[0]?.[0] as Record<string, unknown>
    expect(saved).toMatchObject({
      user_id: 'owner-id',
      org_slug: 'org-slug',
      refresh_token_encrypted: null,
      token_expires_at: null,
      token_refresh_claim: null,
      token_refresh_started_at: null,
    })
    expect(decryptToken(saved.access_token_encrypted as string)).toBe('personal-access-token')
    expect(upsert).toHaveBeenCalledWith(expect.any(Object), { onConflict: 'user_id,org_slug' })
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/accounts')
  })

  it('does not replace an existing account when the new token is rejected', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 401 }))
    expect(await addSupabaseAccount({ accessToken: 'rejected-personal-token' })).toHaveProperty('error')
    expect(upsert).not.toHaveBeenCalled()
  })

  it('requires authentication before validating or saving a token', async () => {
    getUser.mockResolvedValue({ data: { user: null } })
    expect(await addSupabaseAccount({ accessToken: 'personal-access-token' })).toEqual({ error: 'Não autorizado.' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(upsert).not.toHaveBeenCalled()
  })

  it('rejects invalid input before reaching the database', async () => {
    expect(await addSupabaseAccount({ accessToken: 'short' })).toHaveProperty('error')
    expect(mocks.createClient).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
