import { createServiceClient } from '@/lib/supabase/admin'
import { authenticateDeviceSecret } from '@/lib/checkpoint/devices'
import { supabaseCheckpointDeviceStore } from '@/lib/checkpoint/store'
import { boundedJson } from '@/lib/database-inspection/provider'
import { OperationError } from '@/lib/backend-operations/contract'
import { sqlArtifactRequestSchema, SqlArtifactError } from '@/lib/sql-artifacts/contract'
import { pollSqlArtifact, processSqlArtifact, readSqlArtifactAuthority } from '@/lib/sql-artifacts/server'
import { assertSamePolicy } from '@/lib/backend-operations/policy'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export async function POST(request: Request): Promise<Response> {
  const headers = { 'Cache-Control': 'no-store' }
  try {
    const input = sqlArtifactRequestSchema.parse(await boundedJson(request, 8000)), client = createServiceClient()
    const authenticate = () => authenticateDeviceSecret(supabaseCheckpointDeviceStore(client), input.deviceSecret)
    const auth = await authenticate()
    if (!auth.ok) throw new SqlArtifactError('Dispositivo não autorizado.', 401)
    const scope = { client, ownerId: auth.device.ownerUserId, projectId: input.projectId, expectedRef: input.expectedRef, deviceId: auth.device.id,
      verifyIdentity: async () => { const fresh = await authenticate(); return fresh.ok ? fresh.device.ownerUserId : '' } }
    const initial = await readSqlArtifactAuthority(scope)
    const artifact = input.operation === 'poll' ? await pollSqlArtifact(scope, input.sessionId, input.ready) : await processSqlArtifact(scope, input)
    const current = await readSqlArtifactAuthority(scope)
    assertSamePolicy(initial, current)
    if (initial.accountId !== current.accountId || initial.projectRef !== current.projectRef) throw new SqlArtifactError('O destino mudou durante a consulta. Consulte o mesmo pedido antes de continuar.')
    return Response.json({ projectId: input.projectId, artifact }, { headers })
  } catch (error) {
    return Response.json({ error: error instanceof SqlArtifactError || error instanceof OperationError ? error.message : 'Migration não confirmada. Consulte o recibo; nenhuma repetição de SQL foi autorizada.' },
      { status: error instanceof SqlArtifactError || error instanceof OperationError ? error.status : 409, headers })
  }
}
