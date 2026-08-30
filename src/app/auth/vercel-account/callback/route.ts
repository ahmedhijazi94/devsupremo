import { redirect } from 'next/navigation'
import type { NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { encryptToken } from '@/lib/crypto'
import { consumeOAuthState } from '@/lib/oauth-state'
import { exchangeCode, identifyInstallation, oauthConfig } from '@/lib/vercel'

/**
 * Callback da Integration da Vercel.
 *
 * A Vercel devolve o código junto do teamId da instalação — é ele que diz em
 * que conta o token opera, e precisa ser guardado com o token.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const code = searchParams.get('code')
  const state = searchParams.get('state')

  if (searchParams.get('error')) {
    redirect('/accounts?error=vercel_denied')
  }

  if (!code || !state) {
    redirect('/accounts?error=invalid_callback')
  }

  const config = oauthConfig()
  if (!config) {
    redirect('/accounts?error=vercel_oauth_unavailable')
  }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const consumed = await consumeOAuthState(supabase, user.id, 'vercel', state)
  if (!consumed) {
    redirect('/accounts?error=invalid_state')
  }

  const redirectUri = `${process.env.NEXT_PUBLIC_APP_URL}/auth/vercel-account/callback`

  let accountName: string
  let teamId: string | null
  let accessToken: string

  try {
    const exchanged = await exchangeCode(config, code, redirectUri)
    accessToken = exchanged.accessToken
    teamId = exchanged.teamId

    const identity = await identifyInstallation(accessToken, teamId)
    accountName = identity.accountName
  } catch (error) {
    console.error('[vercel] falha ao trocar o código:', error)
    redirect('/accounts?error=vercel_exchange_failed')
  }

  const { data: saved, error: saveError } = await supabase
    .from('vercel_accounts')
    .upsert(
      {
        user_id: user.id,
        account_name: accountName,
        team_id: teamId,
        access_token_encrypted: encryptToken(accessToken),
      },
      { onConflict: 'user_id,team_id' }
    )
    .select('id')
    .single()

  if (saveError || !saved) {
    console.error('[vercel] falha ao salvar a conta:', saveError?.message)
    redirect('/accounts?error=save_failed')
  }

  await supabase.from('audit_logs').insert({
    user_id: user.id,
    action: 'vercel_account.connect',
    resource_type: 'vercel_account',
    resource_id: saved.id,
    metadata: { account: accountName, via: 'oauth' },
    ip_address: null,
  })

  if (consumed.projectId) {
    await supabase
      .from('projects')
      .update({ vercel_account_id: saved.id })
      .eq('id', consumed.projectId)
      .eq('user_id', user.id)

    redirect(`/projects/${consumed.projectId}?success=vercel_connected`)
  }

  redirect('/accounts?success=vercel_connected')
}
