import { z } from 'zod'
import { decryptToken, encryptToken } from '../crypto'
import { AccountTokenClientRejectedError, AccountTokenError } from './errors'
import { boundedJson } from '../database-inspection/provider'

export type AccountProvider = 'github' | 'supabase'
export interface AccountTokenValues {
  access_token_encrypted: string
  refresh_token_encrypted: string | null
  token_expires_at: string | null
}
const token = z.string().min(1).max(12_000).regex(/^[^\s\u0000-\u001f\u007f]+$/)
const responseSchema = z.object({
  access_token: token, refresh_token: token.optional(),
  expires_in: z.number().int().positive().max(31_536_000),
  token_type: z.string().regex(/^bearer$/i).optional(),
})

export function tokenNeedsRefresh(row: AccountTokenValues, now: number): boolean {
  if (!row.refresh_token_encrypted) return false
  return !row.token_expires_at || !(Date.parse(row.token_expires_at) - 300_000 > now)
}

export function currentToken(row: AccountTokenValues, now: number): string {
  if (row.token_expires_at && !(Date.parse(row.token_expires_at) > now)) {
    throw new AccountTokenError('reconnect_required')
  }
  try { return token.parse(decryptToken(row.access_token_encrypted)) }
  catch { throw new AccountTokenError('reconnect_required') }
}

function configuration(provider: AccountProvider): { clientId: string; clientSecret: string } {
  const clientId = process.env[provider === 'github' ? 'GITHUB_CLIENT_ID' : 'SUPABASE_OAUTH_CLIENT_ID']
  const clientSecret = process.env[provider === 'github' ? 'GITHUB_CLIENT_SECRET' : 'SUPABASE_OAUTH_CLIENT_SECRET']
  if (!clientId || !clientSecret) throw new AccountTokenError('unavailable')
  return { clientId, clientSecret }
}

/** Validate local prerequisites before acquiring a non-replayable refresh claim. */
export function assertRefreshReady(provider: AccountProvider, row: AccountTokenValues): void {
  configuration(provider)
  try {
    token.parse(decryptToken(row.refresh_token_encrypted ?? ''))
    // Check encryption availability before the provider can rotate its token.
    encryptToken('refresh-readiness')
  } catch { throw new AccountTokenError('reconnect_required') }
}

export async function renewAccountToken(provider: AccountProvider, row: AccountTokenValues): Promise<{ token: string; update: AccountTokenValues }> {
  const { clientId, clientSecret } = configuration(provider)
  let refreshToken: string
  try { refreshToken = token.parse(decryptToken(row.refresh_token_encrypted ?? '')) }
  catch { throw new AccountTokenError('reconnect_required') }
  const label = provider === 'github' ? 'GitHub' : 'Supabase'
  let response: Response
  try {
    response = await fetch(provider === 'github' ? 'https://github.com/login/oauth/access_token' : 'https://api.supabase.com/v1/oauth/token', {
      method: 'POST', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15_000),
      headers: provider === 'github'
        ? { Accept: 'application/json', 'Content-Type': 'application/json' }
        : { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}` },
      body: provider === 'github'
        ? JSON.stringify({ client_id: clientId, client_secret: clientSecret, grant_type: 'refresh_token', refresh_token: refreshToken })
        : new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
    })
  } catch { throw new AccountTokenError('unavailable') }
  let raw: unknown
  try { raw = await boundedJson(response, 48_000) }
  catch { throw new AccountTokenError('unavailable') }
  const denied = z.object({ error: z.string() }).safeParse(raw)
  if (denied.success && ['incorrect_client_credentials', 'invalid_client'].includes(denied.data.error)) {
    throw new AccountTokenClientRejectedError()
  }
  if (denied.success && ['invalid_grant', 'bad_refresh_token'].includes(denied.data.error)) {
    throw new AccountTokenError('reconnect_required', `Não foi possível renovar o acesso. Reconecte o ${label} em Contas.`)
  }
  if (!response.ok || denied.success) throw new AccountTokenError('unavailable')
  const parsed = responseSchema.safeParse(raw)
  if (!parsed.success) throw new AccountTokenError('unavailable')
  try {
    return {
      token: parsed.data.access_token,
      update: {
        access_token_encrypted: encryptToken(parsed.data.access_token),
        refresh_token_encrypted: parsed.data.refresh_token ? encryptToken(parsed.data.refresh_token) : row.refresh_token_encrypted,
        token_expires_at: new Date(Date.now() + parsed.data.expires_in * 1000).toISOString(),
      },
    }
  } catch { throw new AccountTokenError('unavailable') }
}
