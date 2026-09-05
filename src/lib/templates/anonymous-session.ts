/** Browser helper, invoked only by a feature that requires private guest identity. */
export function anonymousSessionHelper(): string {
  return `import { createBrowserClient } from '@supabase/ssr'
import type { SupabaseClient } from '@supabase/supabase-js'

let pending: Promise<SupabaseClient> | null = null

/** Reuse the session cookie. Auth failure is visible; never store feature data locally. */
export function ensurePrivateSession(captchaToken?: string): Promise<SupabaseClient> {
  if (pending) return pending
  pending = startSession(captchaToken).finally(() => { pending = null })
  return pending
}

async function startSession(captchaToken?: string): Promise<SupabaseClient> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !key) throw new Error('Backend não configurado. Seus dados não foram salvos.')
  const client = createBrowserClient(url, key)
  const { data, error } = await client.auth.getSession()
  if (error) throw new Error('Não foi possível recuperar sua sessão. Tente novamente.')
  if (!data.session) {
    const signedIn = await client.auth.signInAnonymously(captchaToken ? { options: { captchaToken } } : undefined)
    if (signedIn.error || !signedIn.data.session) {
      throw new Error('Não foi possível iniciar sua sessão privada. O backend precisa estar disponível e permitir acesso anônimo.')
    }
  }
  return client
}
`
}
