import { type NextRequest } from 'next/server'
import { parseAuthorizationHeader, resolveMcpToken } from '@/lib/mcp/tokens'
import { signRealtimeToken } from '@/lib/realtime-token'
import { runtimeChannel } from '@/lib/runtime/realtime-broadcast'

/**
 * Handshake do companion: troca o token pessoal (sup_…) por uma sessão de
 * Supabase Realtime ESCOPADA ao usuário. O companion entra só no canal do
 * próprio usuário; nenhum token de admin/service_role sai daqui.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function unauthorized(detail: string): Response {
  return Response.json({ error: detail }, { status: 401 })
}

export async function POST(request: NextRequest): Promise<Response> {
  const token = parseAuthorizationHeader(request.headers.get('authorization'))
  if (!token) return unauthorized('Envie Authorization: Bearer sup_… (gere em /mcps).')

  const identity = await resolveMcpToken(token)
  if (!identity) return unauthorized('Token inválido, revogado ou expirado.')

  const secret = process.env.SUPABASE_JWT_SECRET
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!secret || !supabaseUrl || !supabaseAnonKey) {
    return Response.json(
      { error: 'Runtime não configurado no servidor (Realtime/JWT).' },
      { status: 500 },
    )
  }

  const { token: realtimeToken } = signRealtimeToken(identity.userId, secret, 3600)

  return Response.json({
    userId: identity.userId,
    supabaseUrl,
    supabaseAnonKey,
    realtimeToken,
    channel: runtimeChannel(identity.userId),
  })
}
