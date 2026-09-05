import { type NextRequest } from 'next/server'
import { z } from 'zod'
import { createServiceClient } from '@/lib/supabase/admin'
import { authenticateDeviceSecret } from '@/lib/checkpoint/devices'
import {
  supabaseCheckpointDeviceStore,
  claimPendingRestoreRequests,
  getCheckpointForRestore,
} from '@/lib/checkpoint/store'
import { authorizeRestoreRequest } from '@/lib/checkpoint/restore'

/**
 * O daemon consulta ("poll") se há pedidos de "Restaurar" pendentes para o
 * projeto. Reivindica (claim) atomicamente os que achar — evita duas máquinas/
 * instâncias aplicando o mesmo restore. Devolve o alvo (checkpoint_id + o SHA
 * local + resumo, para o daemon achar o commit NA SUA PRÓPRIA fila local) — o
 * daemon aplica localmente (patch + commit, sem tocar o worktree do usuário além
 * do que o restore pede) e reporta em /restore-report.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  deviceSecret: z.string().min(10),
  projectId: z.string().uuid(),
})

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

  // O device precisa ser do DONO do projeto (mesma checagem do publish).
  const { data: proj } = await client
    .from('projects')
    .select('id, user_id')
    .eq('id', body.projectId)
    .maybeSingle()
  if (!proj || (proj.user_id as string) !== auth.device.ownerUserId) {
    return Response.json({ requests: [] })
  }

  const claimed = await claimPendingRestoreRequests(client, {
    projectId: body.projectId,
    deviceId: auth.device.id,
  })

  const requests = []
  for (const r of claimed) {
    const target = await getCheckpointForRestore(client, r.targetCheckpointId)
    const decision = authorizeRestoreRequest({ projectId: body.projectId, target })
    if (!decision.ok) continue // não deveria acontecer (claim já filtrou por projeto)
    requests.push({
      restoreRequestId: r.id,
      targetCheckpointId: r.targetCheckpointId,
      targetSummary: target!.summary,
    })
  }
  return Response.json({ requests })
}
