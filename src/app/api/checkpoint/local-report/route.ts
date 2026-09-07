import { authenticateDeviceSecret } from '@/lib/checkpoint/devices'
import { localCheckpointReportSchema, readLocalReportBody } from '@/lib/checkpoint/local-report'
import { reportLocalCheckpoint, supabaseCheckpointDeviceStore } from '@/lib/checkpoint/store'
import { createServiceClient } from '@/lib/supabase/admin'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 10

const headers = { 'Cache-Control': 'no-store' }

/** Device auth + project owner; the API proxy supplies the same rate limit as publish. */
export async function POST(request: Request): Promise<Response> {
  const parsed = localCheckpointReportSchema.safeParse(await readLocalReportBody(request))
  if (!parsed.success) return Response.json({ error: 'payload inválido.' }, { status: 400, headers })
  try {
    const client = createServiceClient()
    const auth = await authenticateDeviceSecret(supabaseCheckpointDeviceStore(client), parsed.data.deviceSecret)
    if (!auth.ok) return Response.json({ error: 'device não autorizado.' }, { status: 401, headers })
    const { data: project, error } = await client.from('projects').select('id, user_id')
      .eq('id', parsed.data.projectId).maybeSingle()
    if (error) throw new Error('Projeto indisponível.')
    if (!project || project.user_id !== auth.device.ownerUserId) {
      return Response.json({ error: 'projeto não autorizado.' }, { status: 403, headers })
    }
    const outcome = await reportLocalCheckpoint(client, auth.device.id, parsed.data)
    if (outcome === 'conflict') return Response.json({ error: 'identidade do checkpoint divergente.' }, { status: 409, headers })
    return Response.json({ reported: true }, { headers })
  } catch {
    return Response.json({ error: 'Registro indisponível; o daemon tentará novamente.' }, { status: 503, headers })
  }
}
