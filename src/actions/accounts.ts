'use server'

import { createClient } from '@/lib/supabase/server'
import { encryptToken } from '@/lib/crypto'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import crypto from 'crypto'
import { z } from 'zod'

// ─────────────────────────────────────────────────────────────
// Iniciar conexão GitHub — gera state CSRF e redireciona
// ─────────────────────────────────────────────────────────────
export async function connectGithubAccount(projectId?: string) {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // Pass CSRF token and optionally projectId in the state
  const csrfToken = crypto.randomBytes(32).toString('hex')
  const stateObj = { csrf: csrfToken, projectId: projectId || null }
  const state = Buffer.from(JSON.stringify(stateObj)).toString('base64')

  // Salvar state no banco para verificar no callback (TTL via created_at)
  await supabase.from('audit_logs').insert({
    user_id: user.id,
    action: 'github_oauth_state',
    resource_type: 'oauth',
    resource_id: csrfToken, // Use csrfToken as the lookup key
  })

  // Redirecionar para GitHub OAuth com escopos necessários para criar repos
  const params = new URLSearchParams({
    client_id: process.env.GITHUB_CLIENT_ID!,
    redirect_uri: `${process.env.NEXT_PUBLIC_APP_URL}/auth/github-account/callback`,
    scope: 'repo,read:user,user:email,delete_repo',
    state,
  })

  redirect(`https://github.com/login/oauth/authorize?${params.toString()}`)
}

// ─────────────────────────────────────────────────────────────
// Desconectar conta GitHub
// ─────────────────────────────────────────────────────────────
export async function disconnectGithubAccount(
  accountId: string
): Promise<{ error?: string }> {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Não autorizado.' }

  // Verificar ownership antes de deletar
  const { data: account } = await supabase
    .from('github_accounts')
    .select('id')
    .eq('id', accountId)
    .eq('user_id', user.id)
    .single()

  if (!account) return { error: 'Conta não encontrada.' }

  const { error } = await supabase
    .from('github_accounts')
    .delete()
    .eq('id', accountId)
    .eq('user_id', user.id)

  if (error) return { error: 'Erro ao desconectar conta.' }

  await supabase.from('audit_logs').insert({
    user_id: user.id,
    action: 'github_account.disconnect',
    resource_type: 'github_account',
    resource_id: accountId,
  })

  revalidatePath('/accounts')
  return {}
}

// ─────────────────────────────────────────────────────────────
// Adicionar conta Supabase via Personal Access Token
// ─────────────────────────────────────────────────────────────
const addSupabaseSchema = z.object({
  accessToken: z.string().min(10, 'Token inválido.'),
  projectId: z.string().uuid().optional(),
})

export async function addSupabaseAccount(
  formData: z.infer<typeof addSupabaseSchema>
): Promise<{ error?: string }> {
  const parsed = addSupabaseSchema.safeParse(formData)
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Token inválido.' }
  }

  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Não autorizado.' }

  // Validar o token buscando as organizações do usuário
  const orgResponse = await fetch('https://api.supabase.com/v1/organizations', {
    headers: {
      'Authorization': `Bearer ${parsed.data.accessToken}`,
      'Content-Type': 'application/json',
    },
  })

  if (!orgResponse.ok) {
    return { error: 'Token inválido ou sem permissões. Verifique seu Supabase Access Token.' }
  }

  const orgs = await orgResponse.json() as Array<{ id: string; name: string; slug: string }>

  if (!orgs || orgs.length === 0) {
    return { error: 'Nenhuma organização encontrada neste token.' }
  }

  // Usar a primeira organização (depois implementamos seleção)
  const org = orgs[0]!
  const encryptedToken = encryptToken(parsed.data.accessToken)

  const { data: upsertData, error: upsertError } = await supabase
    .from('supabase_accounts')
    .upsert({
      user_id: user.id,
      org_name: org.name,
      org_slug: org.slug,
      access_token_encrypted: encryptedToken,
    }, {
      onConflict: 'user_id,org_slug',
    })
    .select('id')
    .single()

  if (upsertError || !upsertData) {
    return { error: 'Erro ao salvar conta Supabase.' }
  }

  // Se tivermos projectId, vinculamos na hora
  if (parsed.data.projectId) {
    await supabase.from('projects').update({ supabase_account_id: upsertData.id }).eq('id', parsed.data.projectId)
    revalidatePath(`/projects/${parsed.data.projectId}`)
  }

  await supabase.from('audit_logs').insert({
    user_id: user.id,
    action: 'supabase_account.connect',
    resource_type: 'supabase_account',
    metadata: { org_name: org.name },
  })

  revalidatePath('/accounts')
  return {}
}

// ─────────────────────────────────────────────────────────────
// Desconectar conta Supabase
// ─────────────────────────────────────────────────────────────
export async function disconnectSupabaseAccount(
  accountId: string
): Promise<{ error?: string }> {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Não autorizado.' }

  const { data: account } = await supabase
    .from('supabase_accounts')
    .select('id')
    .eq('id', accountId)
    .eq('user_id', user.id)
    .single()

  if (!account) return { error: 'Conta não encontrada.' }

  const { error } = await supabase
    .from('supabase_accounts')
    .delete()
    .eq('id', accountId)
    .eq('user_id', user.id)

  if (error) return { error: 'Erro ao desconectar conta.' }

  revalidatePath('/accounts')
  return {}
}

// ─────────────────────────────────────────────────────────────
// Conectar Supabase via OAuth
// ─────────────────────────────────────────────────────────────
export async function connectSupabaseAccount(projectId?: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const clientId = process.env.SUPABASE_OAUTH_CLIENT_ID
  if (!clientId) {
    throw new Error('SUPABASE_OAUTH_CLIENT_ID is not configured')
  }

  // Pass CSRF token and optionally projectId in the state
  const csrfToken = crypto.randomBytes(32).toString('hex')
  const stateObj = { csrf: csrfToken, projectId: projectId || null }
  const state = Buffer.from(JSON.stringify(stateObj)).toString('base64')

  // Salvar state no banco
  await supabase.from('audit_logs').insert({
    user_id: user.id,
    action: 'supabase_oauth_state',
    resource_type: 'oauth',
    resource_id: csrfToken,
  })

  // URL for Supabase OAuth
  const redirectUri = encodeURIComponent(`${process.env.NEXT_PUBLIC_APP_URL}/auth/supabase-account/callback`)
  const authUrl = `https://api.supabase.com/v1/oauth/authorize?client_id=${clientId}&response_type=code&redirect_uri=${redirectUri}&state=${state}`

  redirect(authUrl)
}
