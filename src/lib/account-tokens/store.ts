import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import type { AccountTokenPort, AccountTokenRow } from './service'

const scopeSchema = z.object({
  provider: z.enum(['github', 'supabase']),
  accountId: z.string().uuid(),
  userId: z.string().uuid(),
}).strict()

export type AccountTokenScope = z.infer<typeof scopeSchema>

const rowSchema = z.object({
  access_token_encrypted: z.string().min(1),
  refresh_token_encrypted: z.string().min(1).nullable(),
  token_expires_at: z.string().nullable(),
  token_refresh_claim: z.string().uuid().nullable(),
  token_refresh_started_at: z.string().nullable(),
})
const columns = 'access_token_encrypted,refresh_token_encrypted,token_expires_at,token_refresh_claim,token_refresh_started_at'

function storageFailure(): never {
  throw new Error('Não foi possível acessar a conexão da conta. Tente novamente ou reconecte a conta em Contas.')
}

/** Only a service client may mutate refresh state; every query is scoped to the owner. */
export function accountTokenStore(client: SupabaseClient, input: AccountTokenScope): AccountTokenPort {
  const parsed = scopeSchema.safeParse(input)
  if (!parsed.success) storageFailure()
  const scope = parsed.data
  const args = { p_provider: scope.provider, p_account_id: scope.accountId, p_user_id: scope.userId }
  return {
    provider: scope.provider,
    async read(): Promise<AccountTokenRow | null> {
      try {
        const result = await client.from(`${scope.provider}_accounts`).select(columns)
          .eq('id', scope.accountId).eq('user_id', scope.userId).maybeSingle()
        if (result.error) storageFailure()
        if (!result.data) return null
        const row = rowSchema.safeParse(result.data)
        if (!row.success) storageFailure()
        return row.data
      } catch {
        // Provider/transport diagnostics can contain request data or ciphertext.
        storageFailure()
      }
    },
    async claim(expectedAccess, claimId): Promise<boolean> {
      try {
        const result = await client.rpc('claim_account_token_refresh', {
          ...args, p_expected_access: expectedAccess, p_claim_id: claimId,
        })
        if (result.error || typeof result.data !== 'boolean') storageFailure()
        return result.data
      } catch {
        storageFailure()
      }
    },
    async finish(expectedAccess, claimId, update): Promise<boolean> {
      try {
        const result = await client.rpc('finish_account_token_refresh', {
          ...args, p_expected_access: expectedAccess, p_claim_id: claimId,
          p_access_token_encrypted: update.access_token_encrypted,
          p_refresh_token_encrypted: update.refresh_token_encrypted,
          p_token_expires_at: update.token_expires_at,
        })
        if (result.error || typeof result.data !== 'boolean') storageFailure()
        return result.data
      } catch {
        storageFailure()
      }
    },
  }
}
