import { createClient, type SupabaseClient } from '@supabase/supabase-js'

/** Cliente privilegiado do Control Plane. Cada operação exige autorização do dono. */
export function createServiceClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase não configurado: falta URL ou service role key.')
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}
