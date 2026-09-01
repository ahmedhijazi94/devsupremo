import { type NextRequest } from 'next/server'
import { z } from 'zod'
import { mcpDataClient } from '@/lib/mcp/tokens'
import { startDeviceGrant, supabaseBootstrapStore } from '@/lib/bootstrap/codes'

/**
 * Início do device flow do bootstrap. Não é autenticado: qualquer um pode
 * INICIAR um flow para um projectId (não sensível), mas nada é entregue até o
 * DONO autorizar no browser. Devolve o device_code (segredo do CLI) e o
 * user_code curto (mostrado no browser). Nada de segredo em log.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest): Promise<Response> {
  const body = await request.json().catch(() => null)
  const parsed = z.object({ projectId: z.string().uuid() }).safeParse(body)
  if (!parsed.success) {
    return Response.json({ error: 'projectId inválido.' }, { status: 400 })
  }

  const origin = new URL(request.url).origin
  const ip =
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null

  const store = supabaseBootstrapStore(mcpDataClient())
  const grant = await startDeviceGrant(store, parsed.data.projectId, {
    createdIp: ip,
  })

  return Response.json({
    deviceCode: grant.deviceCode,
    userCode: grant.userCode,
    verificationUri: `${origin}/bootstrap`,
    verificationUriComplete: `${origin}/bootstrap?code=${grant.userCode}`,
    expiresAt: grant.expiresAt,
    intervalSec: grant.intervalSec,
  })
}
