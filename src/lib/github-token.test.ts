import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Cripto vira identidade legível, para o teste focar na DECISÃO de renovar.
vi.mock('./crypto', () => ({
  decryptToken: (s: string) => s.replace(/^enc:/, ''),
  encryptToken: (s: string) => `enc:${s}`,
}))

import {
  ensureFreshGithubToken,
  freshGithubToken,
  expiryFromNow,
} from './github-token'

const HOUR = 3600_000

function fetchReturning(body: unknown, ok = true) {
  return vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 401,
    json: async () => body,
  })
}

describe('ensureFreshGithubToken', () => {
  beforeEach(() => {
    process.env.GITHUB_CLIENT_ID = 'id'
    process.env.GITHUB_CLIENT_SECRET = 'secret'
  })
  afterEach(() => vi.unstubAllGlobals())

  it('token válido: usa o atual, não chama o GitHub', async () => {
    const fetchMock = fetchReturning({})
    vi.stubGlobal('fetch', fetchMock)

    const fresh = await ensureFreshGithubToken({
      access_token_encrypted: 'enc:valido',
      refresh_token_encrypted: 'enc:refresh',
      token_expires_at: new Date(Date.now() + 2 * HOUR).toISOString(),
    })

    expect(fresh.token).toBe('valido')
    expect(fresh.update).toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('sem refresh token (token clássico): nunca renova, mesmo sem validade', async () => {
    const fetchMock = fetchReturning({})
    vi.stubGlobal('fetch', fetchMock)

    const fresh = await ensureFreshGithubToken({
      access_token_encrypted: 'enc:classico',
      refresh_token_encrypted: null,
      token_expires_at: null,
    })

    expect(fresh.token).toBe('classico')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('expirado + refresh: renova e devolve o que gravar', async () => {
    const fetchMock = fetchReturning({
      access_token: 'novo-acesso',
      refresh_token: 'novo-refresh',
      expires_in: 28800,
    })
    vi.stubGlobal('fetch', fetchMock)

    const fresh = await ensureFreshGithubToken({
      access_token_encrypted: 'enc:velho',
      refresh_token_encrypted: 'enc:refresh-velho',
      token_expires_at: new Date(Date.now() - HOUR).toISOString(),
    })

    expect(fresh.token).toBe('novo-acesso')
    expect(fresh.update?.access_token_encrypted).toBe('enc:novo-acesso')
    expect(fresh.update?.refresh_token_encrypted).toBe('enc:novo-refresh')
    expect(fresh.update?.token_expires_at).toBeTruthy()
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('validade nula mas com refresh (projeto antigo): renova por precaução', async () => {
    const fetchMock = fetchReturning({
      access_token: 'renovado',
      refresh_token: 'r2',
      expires_in: 28800,
    })
    vi.stubGlobal('fetch', fetchMock)

    const fresh = await ensureFreshGithubToken({
      access_token_encrypted: 'enc:antigo',
      refresh_token_encrypted: 'enc:r1',
      token_expires_at: null,
    })

    expect(fresh.token).toBe('renovado')
    expect(fresh.update).toBeDefined()
  })

  it('refresh sem novo refresh_token: mantém o refresh atual', async () => {
    vi.stubGlobal(
      'fetch',
      fetchReturning({ access_token: 'so-acesso', expires_in: 28800 }),
    )

    const fresh = await ensureFreshGithubToken({
      access_token_encrypted: 'enc:velho',
      refresh_token_encrypted: 'enc:mantem',
      token_expires_at: new Date(Date.now() - HOUR).toISOString(),
    })

    expect(fresh.update?.refresh_token_encrypted).toBe('enc:mantem')
  })

  it('GitHub recusa o refresh: erro claro pedindo para reconectar', async () => {
    vi.stubGlobal(
      'fetch',
      fetchReturning({ error: 'bad_refresh_token' }, false),
    )

    await expect(
      ensureFreshGithubToken({
        access_token_encrypted: 'enc:velho',
        refresh_token_encrypted: 'enc:expirado',
        token_expires_at: new Date(Date.now() - HOUR).toISOString(),
      }),
    ).rejects.toThrow(/Reconecte o GitHub/)
  })
})

describe('freshGithubToken (grava o token renovado, best-effort)', () => {
  beforeEach(() => {
    process.env.GITHUB_CLIENT_ID = 'id'
    process.env.GITHUB_CLIENT_SECRET = 'secret'
  })
  afterEach(() => vi.unstubAllGlobals())

  it('token válido: não grava nada', async () => {
    vi.stubGlobal('fetch', fetchReturning({}))
    const persist = vi.fn()
    const token = await freshGithubToken(
      {
        access_token_encrypted: 'enc:ok',
        refresh_token_encrypted: 'enc:r',
        token_expires_at: new Date(Date.now() + 2 * HOUR).toISOString(),
      },
      persist,
    )
    expect(token).toBe('ok')
    expect(persist).not.toHaveBeenCalled()
  })

  it('renovou: persiste o update e devolve o novo token', async () => {
    vi.stubGlobal(
      'fetch',
      fetchReturning({ access_token: 'novo', refresh_token: 'r2', expires_in: 28800 }),
    )
    const persist = vi.fn().mockResolvedValue(undefined)
    const token = await freshGithubToken(
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

  it('gravação falha: ainda devolve o token (não quebra a requisição)', async () => {
    vi.stubGlobal(
      'fetch',
      fetchReturning({ access_token: 'novo', expires_in: 28800 }),
    )
    const persist = vi.fn().mockRejectedValue(new Error('db down'))
    const token = await freshGithubToken(
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
  it('calcula o ISO futuro a partir de expires_in', () => {
    const iso = expiryFromNow(3600)
    expect(iso).toBeTruthy()
    expect(Date.parse(iso!)).toBeGreaterThan(Date.now())
  })
  it('sem expires_in → null (token que não expira)', () => {
    expect(expiryFromNow(undefined)).toBeNull()
    expect(expiryFromNow(0)).toBeNull()
  })
})
