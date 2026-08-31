import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('./crypto', () => ({
  decryptToken: (s: string) => s.replace(/^enc:/, ''),
  encryptToken: (s: string) => `enc:${s}`,
}))

import { ensureFreshSupabaseToken } from './supabase-token'

const HOUR = 3600_000

function fetchReturning(body: unknown, ok = true) {
  return vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 401,
    json: async () => body,
  })
}

describe('ensureFreshSupabaseToken', () => {
  beforeEach(() => {
    process.env.SUPABASE_OAUTH_CLIENT_ID = 'id'
    process.env.SUPABASE_OAUTH_CLIENT_SECRET = 'secret'
  })
  afterEach(() => vi.unstubAllGlobals())

  it('token válido: usa o atual, não chama o Supabase', async () => {
    const fetchMock = fetchReturning({})
    vi.stubGlobal('fetch', fetchMock)

    const fresh = await ensureFreshSupabaseToken({
      access_token_encrypted: 'enc:valido',
      refresh_token_encrypted: 'enc:r',
      token_expires_at: new Date(Date.now() + HOUR).toISOString(),
    })

    expect(fresh.token).toBe('valido')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('expirado + refresh: renova, usa Basic auth e devolve o que gravar', async () => {
    const fetchMock = fetchReturning({
      access_token: 'novo',
      refresh_token: 'novo-r',
      expires_in: 3600,
    })
    vi.stubGlobal('fetch', fetchMock)

    const fresh = await ensureFreshSupabaseToken({
      access_token_encrypted: 'enc:velho',
      refresh_token_encrypted: 'enc:r-velho',
      token_expires_at: new Date(Date.now() - HOUR).toISOString(),
    })

    expect(fresh.token).toBe('novo')
    expect(fresh.update?.access_token_encrypted).toBe('enc:novo')
    const init = fetchMock.mock.calls[0]![1]
    expect(init.headers.Authorization).toMatch(/^Basic /)
  })

  it('recusa do Supabase: erro pedindo para reconectar', async () => {
    vi.stubGlobal('fetch', fetchReturning({ error: 'invalid_grant' }, false))

    await expect(
      ensureFreshSupabaseToken({
        access_token_encrypted: 'enc:velho',
        refresh_token_encrypted: 'enc:morto',
        token_expires_at: new Date(Date.now() - HOUR).toISOString(),
      }),
    ).rejects.toThrow(/Reconecte o Supabase/)
  })
})
