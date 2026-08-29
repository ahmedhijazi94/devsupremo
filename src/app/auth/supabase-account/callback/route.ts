import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { encryptToken } from '@/lib/crypto'
import { consumeOAuthState } from '@/lib/oauth-state'

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const code = searchParams.get('code')
  const state = searchParams.get('state')

  if (!code || !state) {
    redirect('/projects?error=invalid_callback')
  }

  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const consumed = await consumeOAuthState(supabase, user.id, 'supabase', state)
  if (!consumed) {
    redirect('/projects?error=invalid_state')
  }

  const clientId = process.env.SUPABASE_OAUTH_CLIENT_ID!
  const clientSecret = process.env.SUPABASE_OAUTH_CLIENT_SECRET!
  const redirectUri = `${process.env.NEXT_PUBLIC_APP_URL}/auth/supabase-account/callback`

  // Trocar o código pelo access_token usando Basic Auth headers
  const tokenUrl = 'https://api.supabase.com/v1/oauth/token'
  
  const authHeader = Buffer.from(`${clientId}:${clientSecret}`).toString('base64')
  
  const tokenRes = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${authHeader}`
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    }),
  })

  const tokenData = await tokenRes.json()

  if (!tokenRes.ok || !tokenData.access_token) {
    console.error('Supabase token error:', tokenData)
    redirect('/projects?error=auth_failed')
  }

  const accessToken = tokenData.access_token
  const refreshToken = tokenData.refresh_token

  // Agora vamos buscar as orgs que o usuário tem acesso com esse token
  const orgRes = await fetch('https://api.supabase.com/v1/organizations', {
    headers: { 'Authorization': `Bearer ${accessToken}` }
  })
  
  if (!orgRes.ok) {
    redirect('/projects?error=org_fetch_failed')
  }
  
  const orgs = await orgRes.json()
  if (!orgs || orgs.length === 0) {
    redirect('/projects?error=no_orgs_found')
  }
  
  // Para simplificar, pegamos a primeira organização ou deixamos o usuário escolher no futuro.
  // Como OAuth concede permissão para a org inteira que ele escolheu no fluxo, a org logada deve estar aqui.
  const org = orgs[0]

  const encryptedToken = encryptToken(accessToken)
  const encryptedRefresh = refreshToken ? encryptToken(refreshToken) : null

  // Salvar no BD
  const { data: upsertData, error: upsertError } = await supabase
    .from('supabase_accounts')
    .upsert({
      user_id: user.id,
      org_name: org.name,
      org_slug: org.id, // Supabase Management API uses id as slug often, but let's stick to id/name.
      access_token_encrypted: encryptedToken,
      refresh_token_encrypted: encryptedRefresh,
    }, {
      onConflict: 'user_id,org_slug',
    })
    .select('id')
    .single()

  if (upsertError || !upsertData) {
    console.error('Supabase Upsert error:', upsertError)
    redirect('/projects?error=save_failed')
  }

  // Se recebemos projectId no state, vincular automaticamente
  if (consumed.projectId) {
    await supabase.from('projects').update({ supabase_account_id: upsertData.id })
      .eq('id', consumed.projectId)
      .eq('user_id', user.id)
    redirect(`/projects/${consumed.projectId}`)
  }

  redirect('/projects?success=supabase_connected')
}
