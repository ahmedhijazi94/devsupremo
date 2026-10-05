import { currentToken, renewAccountToken, tokenNeedsRefresh, type AccountTokenValues } from './account-tokens/provider'

export type GithubTokenRow = AccountTokenValues
export type GithubTokenUpdate = AccountTokenValues
export interface FreshGithubToken { token: string; update?: GithubTokenUpdate }

/** Provider exchange primitive. Production callers use getAccountToken so the
 * account-wide claim and durable save cover the whole rotation. */
export async function ensureFreshGithubToken(row: GithubTokenRow): Promise<FreshGithubToken> {
  return tokenNeedsRefresh(row, Date.now())
    ? renewAccountToken('github', row)
    : { token: currentToken(row, Date.now()) }
}

/** Initial OAuth callbacks may receive classic tokens with no expiry. */
export function expiryFromNow(expiresIn: number | undefined): string | null {
  return expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : null
}
