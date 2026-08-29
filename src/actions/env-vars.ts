'use server'

import { requireProjectOwner } from '@/lib/auth'
import { decryptToken } from '@/lib/crypto'

interface SupabaseApiKey {
  name: string
  api_key: string
}

/**
 * Monta o `.env.local` que o preview injeta no WebContainer.
 *
 * Devolve apenas chaves públicas (`anon`). A service role nunca sai daqui:
 * o preview roda no navegador do usuário, e qualquer coisa entregue a ele
 * é pública na prática.
 */
export async function getProjectEnvVars(
  projectId: string
): Promise<string | null> {
  const { user, supabase, project } = await requireProjectOwner(
    projectId,
    'id, user_id, supabase_account_id, supabase_project_ref'
  )

  const projectRef = project.supabase_project_ref as string | null
  const supabaseAccountId = project.supabase_account_id as string | null

  if (!projectRef) return null

  let anonKey = ''

  if (supabaseAccountId) {
    const { data: account } = await supabase
      .from('supabase_accounts')
      .select('access_token_encrypted')
      .eq('id', supabaseAccountId)
      .eq('user_id', user.id)
      .maybeSingle()

    if (account) {
      const token = decryptToken(account.access_token_encrypted as string)

      const response = await fetch(
        `https://api.supabase.com/v1/projects/${projectRef}/api-keys`,
        { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' }
      )

      if (response.ok) {
        const keys = (await response.json()) as SupabaseApiKey[]
        anonKey = keys.find((key) => key.name === 'anon')?.api_key ?? ''
      }
    }
  }

  return [
    `NEXT_PUBLIC_SUPABASE_URL=https://${projectRef}.supabase.co`,
    `NEXT_PUBLIC_SUPABASE_ANON_KEY=${anonKey}`,
    '',
  ].join('\n')
}
