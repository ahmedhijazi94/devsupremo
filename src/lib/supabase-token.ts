import { currentToken, renewAccountToken, tokenNeedsRefresh, type AccountTokenValues } from './account-tokens/provider'

export type SupabaseTokenRow = AccountTokenValues
export type SupabaseTokenUpdate = AccountTokenValues
export interface FreshSupabaseToken { token: string; update?: SupabaseTokenUpdate }

/** Provider exchange primitive. Production callers use getAccountToken so the
 * account-wide claim and durable save cover the whole rotation. */
export async function ensureFreshSupabaseToken(row: SupabaseTokenRow): Promise<FreshSupabaseToken> {
  return tokenNeedsRefresh(row, Date.now())
    ? renewAccountToken('supabase', row)
    : { token: currentToken(row, Date.now()) }
}

/** Initial OAuth callbacks may receive classic tokens with no expiry. */
export function expiryFromNow(expiresIn: number | undefined): string | null {
  return expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : null
}
