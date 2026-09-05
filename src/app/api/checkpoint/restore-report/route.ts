import { type NextRequest } from 'next/server'
import { z } from 'zod'
import { createServiceClient } from '@/lib/supabase/admin'
import { authenticateDeviceSecret } from '@/lib/checkpoint/devices'
import { authorizeRestoreReport } from '@/lib/checkpoint/restore'
import {
  supabaseCheckpointDeviceStore,
  getRestoreRequestProjectOwner,
  reportRestoreApplied,
  reportRestoreFailed,
} from '@/lib/checkpoint/store'

/**
 * O daemon reporta o resultado de um restore que reivindicou. `applied` aponta
 * para o checkpoint NOVO ("E") que o restore criou (ou null se o alvo já era o
 * estado atual — nada a restaurar). O checkpoint E em si segue o fluxo NORMAL de
 * publish (mesma fila, mesmos gates) — esta rota só fecha o pedido de restore.
 *
 * `createServiceClient()` é service_role (ignora RLS) — autenticar o DEVICE não
 * basta; confirmamos que o restoreRequestId pertence a um projeto do MESMO
 * dono do device antes de qualquer escrita (authorizeRestoreReport, fail-
 * closed). Sem isto, um device autenticado de QUALQUER projeto conseguiria
 * fechar o pedido de restore de outro usuário — IDOR.
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
  const client = createServiceClient()

  const auth = await authenticateDeviceSecret(
    supabaseCheckpointDeviceStore(client),
    body.deviceSecret,
  )
  if (!auth.ok) return Response.json({ error: 'device não autorizado.' }, { status: 401 })

  // O restoreRequestId precisa ser de um projeto do MESMO dono do device —
  // nunca de outro usuário. 404 (não 403) para não revelar se o id existe.
  const restoreRequest = await getRestoreRequestProjectOwner(client, body.restoreRequestId)
  const authz = authorizeRestoreReport({
    device: { ownerUserId: auth.device.ownerUserId },
    restoreRequest,
  })
  if (!authz.ok) {
    return Response.json({ error: 'pedido de restore não encontrado.' }, { status: 404 })
  }

  if (body.status === 'applied') {
    await reportRestoreApplied(client, body.restoreRequestId, body.resultCheckpointId)
  } else {
    await reportRestoreFailed(client, body.restoreRequestId, body.error)
  }
  return Response.json({ ok: true })
}
