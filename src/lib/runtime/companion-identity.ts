import { randomBytes, randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'

/**
 * Identidade dedicada por companion. Cada dispositivo ganha um usuário Supabase
 * Auth PRÓPRIO — o companion nunca usa a sessão do usuário principal. O
 * app_metadata (server-managed, não user_metadata) marca actor_type=companion e
 * o owner, e a RLS do Realtime escopa ao owner; as demais tabelas negam essa
 * identidade por padrão (auth.uid() do companion != user_id do dono).
 *
 * Só o servidor toca o service_role aqui; o companion recebe apenas a sessão do
 * seu usuário dedicado. Vínculo dono↔companion vive na tabela companion_devices,
 * então dá pra revogar um companion sem afetar a sessão web.
 */

export interface CompanionSessionResult {
  companionId: string
  session: { accessToken: string; refreshToken: string }
}

function companionEmail(companionId: string): string {
  return `${companionId}@companions.supremo.app`
}

export async function resolveCompanionSession(
  ownerUserId: string,
  deviceKey: string,
): Promise<CompanionSessionResult> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !anonKey || !serviceKey) {
    throw new Error('Supabase não configurado no servidor.')
  }

  const admin = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  // Vínculo existente dono+device?
  const { data: existing } = await admin
    .from('companion_devices')
    .select('id, auth_user_id, revoked_at')
    .eq('owner_user_id', ownerUserId)
    .eq('device_key', deviceKey)
    .maybeSingle()

  if (existing?.revoked_at) {
    throw new Error('Este companion foi revogado. Registre o dispositivo de novo.')
  }

  let companionId: string
  let authUserId: string
  let email: string

  if (existing) {
    companionId = existing.id as string
    authUserId = existing.auth_user_id as string
    const { data: userData, error } = await admin.auth.admin.getUserById(authUserId)
    if (error || !userData?.user?.email) {
      throw new Error('Identidade do companion não encontrada.')
    }
    email = userData.user.email
  } else {
    // Cria a identidade dedicada, marcada server-side como companion do dono.
    companionId = randomUUID()
    email = companionEmail(companionId)
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email,
      password: randomBytes(24).toString('hex'),
      email_confirm: true,
      app_metadata: {
        actor_type: 'companion',
        owner_user_id: ownerUserId,
        companion_id: companionId,
      },
    })
    if (createErr || !created?.user) {
      throw new Error(`Falha ao criar identidade do companion: ${createErr?.message}`)
    }
    authUserId = created.user.id

    const { error: insertErr } = await admin.from('companion_devices').insert({
      id: companionId,
      owner_user_id: ownerUserId,
      auth_user_id: authUserId,
      device_key: deviceKey,
    })
    if (insertErr) {
      // Desfaz a identidade órfã pra não vazar usuário sem vínculo.
      await admin.auth.admin.deleteUser(authUserId).catch(() => {})
      throw new Error(`Falha ao vincular o companion: ${insertErr.message}`)
    }
  }

  // Emite uma sessão real para a identidade do companion (JWKS; sem JWT secret).
  const { data: link, error: linkErr } = await admin.auth.admin.generateLink({
    type: 'magiclink',
    email,
  })
  const tokenHash = link?.properties?.hashed_token
  if (linkErr || !tokenHash) {
    throw new Error(`Falha ao emitir sessão: ${linkErr?.message ?? 'sem token'}`)
  }

  const anon = createClient(url, anonKey, { auth: { persistSession: false } })
  // type 'email' é o atual para verificação por token_hash (magiclink deprecado).
  const { data: verified, error: verifyErr } = await anon.auth.verifyOtp({
    type: 'email',
    token_hash: tokenHash,
  })
  if (verifyErr || !verified?.session) {
    throw new Error(`Falha ao criar sessão: ${verifyErr?.message ?? 'sem sessão'}`)
  }

  await admin
    .from('companion_devices')
    .update({ last_seen_at: new Date().toISOString() })
    .eq('id', companionId)

  return {
    companionId,
    session: {
      accessToken: verified.session.access_token,
      refreshToken: verified.session.refresh_token,
    },
  }
}
