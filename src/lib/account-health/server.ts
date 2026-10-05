import 'server-only'

import type { AccountHealth } from '@/lib/account-health'
import { getAccountToken } from '@/lib/account-tokens/server'
import { AccountTokenError } from '@/lib/account-tokens/service'
import { decryptToken } from '@/lib/crypto'

const TIMEOUT_MS = 4000

async function probe(
  url: string,
  headers: Record<string, string>,
): Promise<AccountHealth> {
  try {
    const response = await fetch(url, {
      headers,
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })

    if (response.ok) return 'ok'
    if (response.status === 401) return 'expired'
    // 403 também pode indicar limite de requisições ou restrição de permissão.
    return 'unknown'
  } catch {
    return 'unknown'
  }
}

/** Renova e persiste a credencial antes de perguntar ao provedor se ela vale. */
export async function checkConnectedAccount(
  provider: 'github' | 'supabase',
  accountId: string,
  userId: string,
): Promise<AccountHealth> {
  try {
    const token = await getAccountToken({ provider, accountId, userId })
    if (provider === 'github') {
      return await probe('https://api.github.com/user', {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      })
    }

    return await probe('https://api.supabase.com/v1/organizations', {
      Authorization: `Bearer ${token}`,
    })
  } catch (error) {
    // Uma renovação em andamento ou indisponibilidade não invalida a conta.
    return error instanceof AccountTokenError && error.code === 'reconnect_required'
      ? 'expired'
      : 'unknown'
  }
}

export async function checkVercelToken(
  encryptedToken: string,
  teamId: string | null,
): Promise<AccountHealth> {
  try {
    const token = decryptToken(encryptedToken)
    // Tokens de time não têm acesso a /v2/user.
    const url = teamId
      ? `https://api.vercel.com/v2/teams/${teamId}`
      : 'https://api.vercel.com/v2/user'

    return await probe(url, { Authorization: `Bearer ${token}` })
  } catch {
    return 'expired'
  }
}
