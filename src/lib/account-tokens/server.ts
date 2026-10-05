import 'server-only'
import { createServiceClient } from '@/lib/supabase/admin'
import { resolveAccountToken } from './service'
import { accountTokenStore, type AccountTokenScope } from './store'

/** Callers must establish the authenticated or otherwise authorized owner first. */
export async function getAccountToken(scope: AccountTokenScope): Promise<string> {
  return resolveAccountToken(accountTokenStore(createServiceClient(), scope))
}
