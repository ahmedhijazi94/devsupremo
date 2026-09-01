import { type NextRequest } from 'next/server'
import { z } from 'zod'
import { parseAuthorizationHeader, resolveMcpToken } from '@/lib/mcp/tokens'
import { runtimeChannel } from '@/lib/runtime/realtime-broadcast'
import { resolveCompanionSession } from '@/lib/runtime/companion-identity'

/**
 * Handshake do companion — identidade DEDICADA por dispositivo, sem JWT secret.
 *
 * O companion não recebe a sessão do usuário principal: o Supremo dá a ele uma
 * sessão de um usuário Supabase Auth próprio (server-managed, app_metadata marca
 * que é companion e de quem). Assim o Realtime escopa ao owner e as demais
 * tabelas negam essa identidade por padrão. O service_role fica só no servidor;
 * o companion recebe apenas a sessão dedicada. O canal continua sendo o do dono.
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

  const body = await request.json().catch(() => null)
  const parsed = z.object({ deviceKey: z.string().min(8).max(200) }).safeParse(body)
  if (!parsed.success) {
    return fail(400, 'deviceKey ausente/ inválido.')
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !anonKey) return fail(500, 'Supabase não configurado no servidor.')

  try {
    const { companionId, session } = await resolveCompanionSession(
      identity.userId,
      parsed.data.deviceKey,
    )
    return Response.json({
      // O canal é o do DONO; a identidade do companion (app_metadata) autoriza.
      userId: identity.userId,
      companionId,
      supabaseUrl: url,
      supabaseAnonKey: anonKey,
      session,
      channel: runtimeChannel(identity.userId),
    })
  } catch (error) {
    return fail(400, error instanceof Error ? error.message : 'Handshake falhou.')
  }
}
