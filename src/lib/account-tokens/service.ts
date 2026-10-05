import { randomUUID } from 'node:crypto'
import { AccountTokenClientRejectedError, AccountTokenError } from './errors'
import { assertRefreshReady, currentToken, renewAccountToken, tokenNeedsRefresh, type AccountProvider, type AccountTokenValues } from './provider'

export { AccountTokenError } from './errors'
export interface AccountTokenRow extends AccountTokenValues {
  token_refresh_claim: string | null
  token_refresh_started_at: string | null
}
export interface AccountTokenPort {
  provider: AccountProvider
  read(): Promise<AccountTokenRow | null>
  claim(expectedAccess: string, claimId: string): Promise<boolean>
  finish(expectedAccess: string, claimId: string, update: AccountTokenValues): Promise<boolean>
  now?(): number
  sleep?(ms: number): Promise<void>
  id?(): string
}

async function read(port: AccountTokenPort): Promise<AccountTokenRow> {
  let row: AccountTokenRow | null
  try { row = await port.read() }
  catch { throw new AccountTokenError('unavailable') }
  if (!row) throw new AccountTokenError('reconnect_required')
  return row
}

function saved(row: AccountTokenRow, values: AccountTokenValues): boolean {
  return row.token_refresh_claim === null && row.access_token_encrypted === values.access_token_encrypted &&
    row.refresh_token_encrypted === values.refresh_token_encrypted &&
    (row.token_expires_at === values.token_expires_at ||
      (row.token_expires_at !== null && values.token_expires_at !== null && Date.parse(row.token_expires_at) === Date.parse(values.token_expires_at)))
}

/** Only before remote dispatch: restoring the same values cannot repeat a
 * rotation, and the CAS cannot clear another worker's or reconnection's claim. */
async function releaseUnusedClaim(port: AccountTokenPort, row: AccountTokenRow, claimId: string): Promise<void> {
  try { await port.finish(row.access_token_encrypted, claimId, row) }
  catch { throw new AccountTokenError('unavailable') }
}

/** Resolve from authoritative storage on every call, across processes and devices.
 * A lost provider response cannot safely be repeated: abandoned claims require
 * reconnection. Retrying the exact compare-and-swap persistence is safe. */
export async function resolveAccountToken(port: AccountTokenPort): Promise<string> {
  const now = port.now ?? Date.now
  const sleep = port.sleep ?? (async (ms: number) => { await new Promise(resolve => setTimeout(resolve, ms)) })
  for (let attempt = 0; attempt < 40; attempt++) {
    const row = await read(port)
    if (!tokenNeedsRefresh(row, now())) return currentToken(row, now())
    if (row.token_refresh_claim) {
      const started = Date.parse(row.token_refresh_started_at ?? '')
      if (!Number.isFinite(started) || now() - started > 60_000) throw new AccountTokenError('reconnect_required')
      await sleep(100)
      continue
    }
    assertRefreshReady(port.provider, row)
    const claimId = (port.id ?? randomUUID)()
    let claimed: boolean
    try { claimed = await port.claim(row.access_token_encrypted, claimId) }
    catch {
      // The reservation may have committed despite a lost acknowledgement.
      // No provider request has been made by this caller.
      await releaseUnusedClaim(port, row, claimId)
      throw new AccountTokenError('unavailable')
    }
    if (!claimed) { await sleep(100); continue }
    // Reconnection/deletion can invalidate the claim before contacting the provider.
    let confirmed: AccountTokenRow
    try { confirmed = await read(port) }
    catch (error) {
      await releaseUnusedClaim(port, row, claimId)
      throw error
    }
    if (confirmed.token_refresh_claim !== claimId || confirmed.access_token_encrypted !== row.access_token_encrypted) continue
    let fresh: Awaited<ReturnType<typeof renewAccountToken>>
    try { fresh = await renewAccountToken(port.provider, confirmed) }
    catch (error) {
      // This specific provider rejection confirms no token was consumed.
      // Ambiguous HTTP/network failures must keep their reservation.
      if (error instanceof AccountTokenClientRejectedError) await releaseUnusedClaim(port, row, claimId)
      throw error
    }
    for (let saveAttempt = 0; saveAttempt < 2; saveAttempt++) {
      try {
        if (await port.finish(row.access_token_encrypted, claimId, fresh.update)) return fresh.token
      } catch {
        // A lost DB acknowledgement may have committed. Read back before retrying.
      }
      const latest = await read(port)
      if (saved(latest, fresh.update)) return fresh.token
      if (latest.access_token_encrypted !== row.access_token_encrypted || latest.token_refresh_claim !== claimId) {
        // Never use the obsolete result after the owner reconnects this account.
        if (!tokenNeedsRefresh(latest, now())) return currentToken(latest, now())
        throw new AccountTokenError('refresh_pending')
      }
    }
    throw new AccountTokenError('unavailable')
  }
  throw new AccountTokenError('refresh_pending')
}
