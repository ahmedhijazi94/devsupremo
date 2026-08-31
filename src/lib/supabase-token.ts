import { decryptToken, encryptToken } from './crypto'

/**
 * Renovação do token do Supabase — o mesmo desenho do GitHub, e o mesmo perigo.
 *
 * O OAuth do Supabase emite access token de vida curta (cerca de 1 hora) e
 * devolve um refresh token. Sem renovar, a aba Banco e toda operação de banco
 * do MCP (migration, ajuste de dado, introspecção) morrem depois do prazo. Aqui
 * está a lógica; os resolvers chamam e gravam o token novo.
 */

const SUPABASE_OAUTH_TOKEN = 'https://api.supabase.com/v1/oauth/token'
const SKEW_MS = 5 * 60 * 1000

export interface SupabaseTokenRow {
  access_token_encrypted: string
  refresh_token_encrypted: string | null
  token_expires_at: string | null
}

export interface SupabaseTokenUpdate {
  access_token_encrypted: string
  refresh_token_encrypted: string | null
  token_expires_at: string | null
}

export interface FreshSupabaseToken {
  token: string
  update?: SupabaseTokenUpdate
}

export async function ensureFreshSupabaseToken(
  row: SupabaseTokenRow,
): Promise<FreshSupabaseToken> {
  const expiresAt = row.token_expires_at
    ? Date.parse(row.token_expires_at)
    : null
  const stillValid = expiresAt !== null && expiresAt - SKEW_MS > Date.now()

  if (stillValid || !row.refresh_token_encrypted) {
    return { token: decryptToken(row.access_token_encrypted) }
  }

  const refreshed = await refreshSupabaseToken(
    decryptToken(row.refresh_token_encrypted),
  )

  return {
    token: refreshed.accessToken,
    update: {
      access_token_encrypted: encryptToken(refreshed.accessToken),
      refresh_token_encrypted: refreshed.refreshToken
        ? encryptToken(refreshed.refreshToken)
        : row.refresh_token_encrypted,
      token_expires_at: refreshed.expiresAt,
    },
  }
}

/** Token válido a partir da linha, gravando o novo se renovou (best-effort). */
export async function freshSupabaseToken(
  row: SupabaseTokenRow,
  persist: (update: SupabaseTokenUpdate) => PromiseLike<unknown>,
): Promise<string> {
  const fresh = await ensureFreshSupabaseToken(row)
  if (fresh.update) {
    try {
      await persist(fresh.update)
    } catch {
      // gravar falhou — o token renovado ainda serve para esta chamada
    }
  }
  return fresh.token
}

interface RefreshedToken {
  accessToken: string
  refreshToken: string | null
  expiresAt: string | null
}

async function refreshSupabaseToken(
  refreshToken: string,
): Promise<RefreshedToken> {
  const clientId = process.env.SUPABASE_OAUTH_CLIENT_ID
  const clientSecret = process.env.SUPABASE_OAUTH_CLIENT_SECRET
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64')

  const response = await fetch(SUPABASE_OAUTH_TOKEN, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${basic}`,
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  })

  const data = (await response.json().catch(() => null)) as {
    access_token?: string
    refresh_token?: string
    expires_in?: number
    error?: string
    error_description?: string
  } | null

  if (!response.ok || !data || data.error || !data.access_token) {
    const reason =
      data?.error_description ?? data?.error ?? `HTTP ${response.status}`
    throw new Error(
      `Não foi possível renovar o acesso ao Supabase (${reason}). ` +
        'Reconecte o Supabase em Contas.',
    )
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresAt: expiryFromNow(data.expires_in),
  }
}

/** Quando o access token, dado um expires_in em segundos, expira (ISO). */
export function expiryFromNow(expiresIn: number | undefined): string | null {
  return expiresIn
    ? new Date(Date.now() + expiresIn * 1000).toISOString()
    : null
}
