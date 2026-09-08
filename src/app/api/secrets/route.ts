import { createServiceClient } from '@/lib/supabase/admin'
import { authenticateDeviceSecret } from '@/lib/checkpoint/devices'
import { supabaseCheckpointDeviceStore } from '@/lib/checkpoint/store'
import { boundedJson, InspectionError } from '@/lib/database-inspection/provider'
import { safeSecretFailure, secretsRequestSchema } from '@/lib/secret-requests/policy'
import { secretRequestStore } from '@/lib/secret-requests/store'
import { listSecretRequests, requestSecrets } from '@/lib/secret-requests/service'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Device endpoint accepts metadata only. The value is accepted exclusively by the authenticated owner form. */
export async function POST(request: Request): Promise<Response> {
  const headers = { 'Cache-Control': 'no-store' }
  let body: unknown
  try { body = await boundedJson(request, 32000) }
  catch (error) { return Response.json({ error: 'Pedido inválido ou acima do limite.' }, { status: error instanceof InspectionError && error.status === 413 ? 413 : 400, headers }) }
  const parsed = secretsRequestSchema.safeParse(body)
  if (!parsed.success) return Response.json({ error: 'Envie somente nomes, finalidade, destino e ambiente. Valores não são aceitos por esta API.' }, { status: 400, headers })
  try {
    const client = createServiceClient()
    const auth = await authenticateDeviceSecret(supabaseCheckpointDeviceStore(client), parsed.data.deviceSecret)
    if (!auth.ok) return Response.json({ error: 'Dispositivo não autorizado.' }, { status: 401, headers })
    const { projectId } = parsed.data
    const port = secretRequestStore(client, auth.device.ownerUserId, projectId)
    const requests = parsed.data.operation === 'request' ? await requestSecrets(port, parsed.data.requests) : await listSecretRequests(port)
    return Response.json({ projectId, requests: requests.filter((entry) => entry.target && entry.environment && entry.targetRef), formPath: `/projects/${projectId}#secrets` }, { headers })
  } catch (error) { return Response.json(safeSecretFailure(error), { status: 409, headers }) }
}
