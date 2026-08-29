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
export async function connectGithubAccount() {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // Gerar state CSRF aleatório
  const state = crypto.randomBytes(32).toString('hex')

  // Salvar state no banco para verificar no callback (TTL via created_at)
  await supabase.from('audit_logs').insert({
    user_id: user.id,
    action: 'github_oauth_state',
    resource_type: 'oauth',
    resource_id: state,
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

  const { error: upsertError } = await supabase
    .from('supabase_accounts')
    .upsert({
      user_id: user.id,
      org_name: org.name,
      org_slug: org.slug,
      access_token_encrypted: encryptedToken,
    }, {
      onConflict: 'user_id,org_slug',
    })

  if (upsertError) {
    return { error: 'Erro ao salvar conta Supabase.' }
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
