import { type NextRequest } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { parseAuthorizationHeader, resolveMcpToken } from '@/lib/mcp/tokens'
import { runtimeChannel } from '@/lib/runtime/realtime-broadcast'

/**
 * Handshake do companion — modelo MODERNO, sem JWT secret legado.
 *
 * O Supremo emite uma SESSÃO real de Supabase Auth para o usuário (server-side,
 * via Admin API com o service_role que já existe) e a entrega ao companion. O
 * companion vira um usuário autenticado de verdade: os tokens são assinados
 * pelas chaves do PRÓPRIO Supabase (JWKS), o Supremo não assina nada, e nenhum
 * SUPABASE_JWT_SECRET é necessário. O service_role nunca sai do servidor; o
 * companion recebe só a sessão do usuário, que o RLS de realtime.messages
 * escopa ao canal dele (auth.uid()).
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function fail(status: number, detail: string): Response {
  return Response.json({ error: detail }, { status })
}

export async function POST(request: NextRequest): Promise<Response> {
  const token = parseAuthorizationHeader(request.headers.get('authorization'))
  if (!token) return fail(401, 'Envie Authorization: Bearer sup_… (gere em /mcps).')

  const identity = await resolveMcpToken(token)
  if (!identity) return fail(401, 'Token inválido, revogado ou expirado.')

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !anonKey || !serviceKey) {
    return fail(500, 'Supabase não configurado no servidor.')
  }

  const admin = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  // 1. E-mail do usuário (para gerar o link). O service_role fica só aqui.
  const { data: userData, error: userErr } = await admin.auth.admin.getUserById(
    identity.userId,
  )
  const email = userData?.user?.email
  if (userErr || !email) {
    return fail(400, 'Usuário sem e-mail para emitir a sessão.')
  }

  // 2. Gera um magic link (NÃO envia e-mail — só devolve o token_hash).
  const { data: link, error: linkErr } = await admin.auth.admin.generateLink({
    type: 'magiclink',
    email,
  })
  const tokenHash = link?.properties?.hashed_token
  if (linkErr || !tokenHash) {
    return fail(500, `Falha ao emitir sessão: ${linkErr?.message ?? 'sem token'}`)
  }

  // 3. Troca o token_hash por uma SESSÃO real (access + refresh). Cliente anon.
  const anon = createClient(url, anonKey, { auth: { persistSession: false } })
  const { data: verified, error: verifyErr } = await anon.auth.verifyOtp({
    type: 'email',
    token_hash: tokenHash,
  })
  const session = verified?.session
  if (verifyErr || !session) {
    return fail(500, `Falha ao criar sessão: ${verifyErr?.message ?? 'sem sessão'}`)
  }

  return Response.json({
    userId: identity.userId,
    supabaseUrl: url,
    supabaseAnonKey: anonKey,
    session: {
      accessToken: session.access_token,
      refreshToken: session.refresh_token,
    },
    channel: runtimeChannel(identity.userId),
  })
}
