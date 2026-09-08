import { z } from 'zod'
import { createServiceClient } from '@/lib/supabase/admin'
import { authenticateDeviceSecret } from '@/lib/checkpoint/devices'
import { readLocalReportBody } from '@/lib/checkpoint/local-report'
import { sanitizeDiagnostic } from '@/lib/checkpoint/feedback'
import { reportRestoreApplied, reportRestoreFailed, supabaseCheckpointDeviceStore } from '@/lib/checkpoint/store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const headers = { 'Cache-Control': 'no-store' }
const identity = {
  deviceSecret: z.string().min(10).max(256), projectId: z.string().uuid(),
  restoreRequestId: z.string().uuid(), claimToken: z.string().uuid(),
}
const bodySchema = z.discriminatedUnion('status', [
  z.object({ ...identity, status: z.literal('applied'), resultCheckpointId: z.string().uuid().nullable(),
    resultCommitSha: z.string().regex(/^[a-f0-9]{40}$/).nullable() }).strict(),
  z.object({ ...identity, status: z.literal('failed'), error: z.string().min(1).max(500) }).strict(),
]).refine((body) => body.status !== 'applied' || (body.resultCheckpointId === null) === (body.resultCommitSha === null))

/** Atomic owner/device/claim checks, metadata registration and durable ACK. */
export async function POST(request: Request): Promise<Response> {
  const parsed = bodySchema.safeParse(await readLocalReportBody(request))
  if (!parsed.success) return Response.json({ error: 'payload inválido.' }, { status: 400, headers })
  try {
    const body = parsed.data
    const client = createServiceClient()
    const auth = await authenticateDeviceSecret(supabaseCheckpointDeviceStore(client), body.deviceSecret)
    if (!auth.ok) return Response.json({ error: 'device não autorizado.' }, { status: 401, headers })
    const authority = { id: body.restoreRequestId, projectId: body.projectId, deviceId: auth.device.id, claimToken: body.claimToken }
    const acknowledged = body.status === 'applied'
      ? await reportRestoreApplied(client, authority, body.resultCheckpointId, body.resultCommitSha)
      : await reportRestoreFailed(client, authority, sanitizeDiagnostic(body.error).slice(0,500))
    if (!acknowledged) return Response.json({ error: 'Identidade ou resultado da restauração divergente.' }, { status: 409, headers })
    return Response.json({ ok: true }, { headers })
  } catch {
    return Response.json({ error: 'Confirmação pendente; tente novamente.' }, { status: 503, headers })
  }
}
