import { type NextRequest } from 'next/server'
import { z } from 'zod'
import { mcpDataClient } from '@/lib/mcp/tokens'
import { authenticateDeviceSecret } from '@/lib/checkpoint/devices'
import {
  supabaseCheckpointDeviceStore,
  reportRestoreApplied,
  reportRestoreFailed,
} from '@/lib/checkpoint/store'

/**
 * O daemon reporta o resultado de um restore que reivindicou. `applied` aponta
 * para o checkpoint NOVO ("E") que o restore criou (ou null se o alvo já era o
 * estado atual — nada a restaurar). O checkpoint E em si segue o fluxo NORMAL de
 * publish (mesma fila, mesmos gates) — esta rota só fecha o pedido de restore.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const bodySchema = z.discriminatedUnion('status', [
  z.object({
    deviceSecret: z.string().min(10),
    restoreRequestId: z.string().uuid(),
    status: z.literal('applied'),
    resultCheckpointId: z.string().uuid().nullable(),
  }),
  z.object({
    deviceSecret: z.string().min(10),
    restoreRequestId: z.string().uuid(),
    status: z.literal('failed'),
    error: z.string().min(1).max(500),
  }),
])

export async function POST(request: NextRequest): Promise<Response> {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return Response.json({ error: 'payload inválido.' }, { status: 400 })
  const body = parsed.data
  const client = mcpDataClient()

  const auth = await authenticateDeviceSecret(
    supabaseCheckpointDeviceStore(client),
    body.deviceSecret,
  )
  if (!auth.ok) return Response.json({ error: 'device não autorizado.' }, { status: 401 })

  if (body.status === 'applied') {
    await reportRestoreApplied(client, body.restoreRequestId, body.resultCheckpointId)
  } else {
    await reportRestoreFailed(client, body.restoreRequestId, body.error)
  }
  return Response.json({ ok: true })
}
