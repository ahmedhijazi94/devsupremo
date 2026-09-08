import { z } from 'zod'
import { createServiceClient } from '@/lib/supabase/admin'
import { authenticateDeviceSecret } from '@/lib/checkpoint/devices'
import { supabaseCheckpointDeviceStore, claimPendingRestoreRequests, getCheckpointForRestore } from '@/lib/checkpoint/store'
import { authorizeRestoreRequest } from '@/lib/checkpoint/restore'
import { readLocalReportBody } from '@/lib/checkpoint/local-report'
import { readEnvironment } from '@/lib/database-environment/store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const headers = { 'Cache-Control': 'no-store' }
const bodySchema = z.object({ deviceSecret: z.string().min(10).max(256), projectId: z.string().uuid() }).strict()

/** Renewable delivery to the original workstation; mutation/result use a durable claim identity. */
export async function POST(request: Request): Promise<Response> {
  const parsed = bodySchema.safeParse(await readLocalReportBody(request))
  if (!parsed.success) return Response.json({ error: 'payload inválido.' }, { status: 400, headers })
  try {
    const body = parsed.data
    const client = createServiceClient()
    const auth = await authenticateDeviceSecret(supabaseCheckpointDeviceStore(client), body.deviceSecret)
    if (!auth.ok) return Response.json({ error: 'device não autorizado.' }, { status: 401, headers })
    const { data: project, error } = await client.from('projects').select('id, user_id').eq('id', body.projectId).maybeSingle()
    if (error) throw new Error('Projeto indisponível.')
    if (!project || project.user_id !== auth.device.ownerUserId) return Response.json({ requests: [] }, { headers })
    const environment = await readEnvironment(client, body.projectId)
    if (environment?.environment !== 'development') return Response.json({ requests: [] }, { headers })
    const claimed = await claimPendingRestoreRequests(client, { projectId: body.projectId, deviceId: auth.device.id })
    const requests = []
    for (const entry of claimed) {
      const target = await getCheckpointForRestore(client, entry.targetCheckpointId)
      if (!target || !authorizeRestoreRequest({ projectId: body.projectId, target }).ok) continue
      requests.push({ restoreRequestId: entry.id, targetCheckpointId: entry.targetCheckpointId,
        targetSummary: target.summary, claimToken: entry.claimToken, leaseExpiresAt: entry.leaseExpiresAt,
        environment: 'development' })
    }
    return Response.json({ requests }, { headers })
  } catch {
    return Response.json({ error: 'Restaurações indisponíveis; tente novamente.' }, { status: 503, headers })
  }
}
