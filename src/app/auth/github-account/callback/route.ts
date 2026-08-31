import { createClient } from '@/lib/supabase/server'
import { encryptToken } from '@/lib/crypto'
import { expiryFromNow } from '@/lib/github-token'
import { redirect } from 'next/navigation'
import { type NextRequest } from 'next/server'
import { consumeOAuthState } from '@/lib/oauth-state'

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const code = searchParams.get('code')
  const state = searchParams.get('state')
  const error = searchParams.get('error')

  // Erros do GitHub
  if (error) {
    redirect('/accounts?error=github_denied')
  }

  if (!code || !state) {
    redirect('/accounts?error=invalid_callback')
  }

  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // Valida e consome o state na mesma operação: uso único.
  const consumed = await consumeOAuthState(supabase, user.id, 'github', state)
  if (!consumed) {
    redirect('/accounts?error=invalid_state')
  }

  // Trocar code por access_token via GitHub API
  const tokenResponse = await fetch(
    'https://github.com/login/oauth/access_token',
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client_id: process.env.GITHUB_CLIENT_ID,
        client_secret: process.env.GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: `${process.env.NEXT_PUBLIC_APP_URL}/auth/github-account/callback`,
      }),
    },
  )

  if (!tokenResponse.ok) {
    redirect('/accounts?error=token_exchange_failed')
  }

  const tokenData = (await tokenResponse.json()) as {
    access_token?: string
    refresh_token?: string
    expires_in?: number
    scope?: string
    error?: string
  }

  if (tokenData.error || !tokenData.access_token) {
    redirect('/accounts?error=no_access_token')
  }

  // Buscar dados do usuário GitHub
  const userResponse = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${tokenData.access_token}`,
      Accept: 'application/vnd.github.v3+json',
    },
  })

  if (!userResponse.ok) {
    redirect('/accounts?error=github_user_fetch_failed')
  }

  const githubUser = (await userResponse.json()) as {
    id: number
    login: string
    name: string | null
    avatar_url: string
  }

  // Encriptar tokens com AES-256-GCM
  const encryptedToken = encryptToken(tokenData.access_token)
  const encryptedRefresh = tokenData.refresh_token
    ? encryptToken(tokenData.refresh_token)
    : null

  // Salvar ou atualizar conta GitHub (upsert — evita duplicatas)
  const { data: upsertData, error: upsertError } = await supabase
    .from('github_accounts')
    .upsert(
      {
        user_id: user.id,
        github_user_id: githubUser.id,
        login: githubUser.login,
        name: githubUser.name,
        avatar_url: githubUser.avatar_url,
        access_token_encrypted: encryptedToken,
        refresh_token_encrypted: encryptedRefresh,
        token_expires_at: expiryFromNow(tokenData.expires_in),
        scopes: tokenData.scope?.split(',') ?? [],
      },
      {
        onConflict: 'user_id,github_user_id',
      },
    )
    .select('id')
    .single()

  if (upsertError || !upsertData) {
    console.error('[GitHub Callback] Upsert error:', upsertError?.message)
    redirect('/accounts?error=save_failed')
  }

  // Log de auditoria
  await supabase.from('audit_logs').insert({
    user_id: user.id,
    action: 'github_account.connect',
    resource_type: 'github_account',
    metadata: { login: githubUser.login },
  })

  // Se recebemos projectId no state, vincular automaticamente
  if (consumed.projectId) {
    await supabase
      .from('projects')
      .update({ github_account_id: upsertData.id })
      .eq('id', consumed.projectId)
      .eq('user_id', user.id)
    redirect(`/projects/${consumed.projectId}`)
  }

  redirect('/accounts?success=github_connected')
}
