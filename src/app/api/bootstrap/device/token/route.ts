import { type NextRequest } from 'next/server'
import { z } from 'zod'
import { mcpDataClient } from '@/lib/mcp/tokens'
import { pollDeviceGrant } from '@/lib/bootstrap/codes'
import { supabaseBootstrapStore } from '@/lib/bootstrap/supabase-store'
import { resolveBootstrapConfig } from '@/lib/bootstrap/config'

/**
 * Poll do device flow. O CLL manda o device_code; se o dono já autorizou,
 * consome (one-time) e devolve a config autorizada. Enquanto pendente, devolve
 * `pending` pro CLI esperar. Nunca loga segredo; nunca entrega service_role.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest): Promise<Response> {
  const body = await request.json().catch(() => null)
  const parsed = z.object({ deviceCode: z.string().min(10) }).safeParse(body)
  if (!parsed.success) {
    return Response.json({ error: 'deviceCode inválido.' }, { status: 400 })
  }

  const store = supabaseBootstrapStore(mcpDataClient())
  const result = await pollDeviceGrant(store, parsed.data.deviceCode)

  switch (result.status) {
    case 'pending':
      return Response.json({ status: 'pending' })
    case 'ready':
      try {
        const config = await resolveBootstrapConfig(result.scope)
        return Response.json({ status: 'ready', config })
      } catch (error) {
        return Response.json(
          {
            status: 'error',
            error:
              error instanceof Error
                ? error.message
                : 'Falha ao resolver a config.',
          },
          { status: 400 },
        )
      }
    case 'expired':
      return Response.json({ status: 'expired' }, { status: 410 })
    case 'denied':
      return Response.json({ status: 'denied' }, { status: 403 })
    case 'gone':
    default:
      return Response.json({ status: 'gone' }, { status: 410 })
  }
}
