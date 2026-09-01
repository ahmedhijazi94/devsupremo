import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('./crypto', () => ({
  decryptToken: (s: string) => s.replace(/^enc:/, ''),
  encryptToken: (s: string) => `enc:${s}`,
}))

import {
  ensureFreshSupabaseToken,
  freshSupabaseToken,
  expiryFromNow,
} from './supabase-token'

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

describe('freshSupabaseToken (grava o renovado, best-effort)', () => {
  beforeEach(() => {
    process.env.SUPABASE_OAUTH_CLIENT_ID = 'id'
    process.env.SUPABASE_OAUTH_CLIENT_SECRET = 'secret'
  })
  afterEach(() => vi.unstubAllGlobals())

  it('token válido: não grava', async () => {
    vi.stubGlobal('fetch', fetchReturning({}))
    const persist = vi.fn()
    const token = await freshSupabaseToken(
      {
        access_token_encrypted: 'enc:ok',
        refresh_token_encrypted: 'enc:r',
        token_expires_at: new Date(Date.now() + HOUR).toISOString(),
      },
      persist,
    )
    expect(token).toBe('ok')
    expect(persist).not.toHaveBeenCalled()
  })

  it('renovou: persiste e devolve o novo', async () => {
    vi.stubGlobal(
      'fetch',
      fetchReturning({ access_token: 'novo', refresh_token: 'r2', expires_in: 3600 }),
    )
    const persist = vi.fn().mockResolvedValue(undefined)
    const token = await freshSupabaseToken(
      {
        access_token_encrypted: 'enc:velho',
        refresh_token_encrypted: 'enc:r1',
        token_expires_at: new Date(Date.now() - HOUR).toISOString(),
      },
      persist,
    )
    expect(token).toBe('novo')
    expect(persist).toHaveBeenCalledWith(
      expect.objectContaining({ access_token_encrypted: 'enc:novo' }),
    )
  })

  it('gravação falha: ainda devolve o token', async () => {
    vi.stubGlobal(
      'fetch',
      fetchReturning({ access_token: 'novo', expires_in: 3600 }),
    )
    const persist = vi.fn().mockRejectedValue(new Error('db down'))
    const token = await freshSupabaseToken(
      {
        access_token_encrypted: 'enc:velho',
        refresh_token_encrypted: 'enc:r1',
        token_expires_at: new Date(Date.now() - HOUR).toISOString(),
      },
      persist,
    )
    expect(token).toBe('novo')
  })
})

describe('expiryFromNow', () => {
  it('expires_in → ISO futuro', () => {
    const iso = expiryFromNow(3600)
    expect(Date.parse(iso!)).toBeGreaterThan(Date.now())
  })
  it('sem expires_in → null', () => {
    expect(expiryFromNow(undefined)).toBeNull()
  })
})
