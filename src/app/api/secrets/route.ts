import { operationApprovalErrorBody } from '@/lib/backend-operations/approval-contract'
import { createServiceClient } from '@/lib/supabase/admin'
import { authenticateDeviceSecret } from '@/lib/checkpoint/devices'
import { supabaseCheckpointDeviceStore } from '@/lib/checkpoint/store'
import { boundedJson, InspectionError } from '@/lib/database-inspection/provider'
import { safeSecretFailure, secretsRequestSchema } from '@/lib/secret-requests/policy'
import { secretRequestStore } from '@/lib/secret-requests/store'
import { dismissRequestedSecret, listSecretRequests, requestSecrets } from '@/lib/secret-requests/service'
import { credentialStore } from '@/lib/credentials/store'
import { listProjectCredentials } from '@/lib/credentials/service'

import { runDeviceCredentialOperation } from '@/lib/credentials/device'
import { SecretRequestError } from '@/lib/secret-requests/policy'
import { OperationError } from '@/lib/backend-operations/contract'

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
    const verifyIdentity=async()=>{
      const current=await authenticateDeviceSecret(supabaseCheckpointDeviceStore(client),parsed.data.deviceSecret)
      return current.ok?current.device.ownerUserId:''
    }
    const verify=async()=>{if(await verifyIdentity()!==auth.device.ownerUserId)throw new SecretRequestError('Dispositivo revogado ou sessão alterada.')}
    let receipt
    if(parsed.data.operation==='apply'||parsed.data.operation==='revoke-credential'){
      const operation=parsed.data.operation==='apply'?{operation:parsed.data.operation,requestId:parsed.data.requestId,credentialId:parsed.data.credentialId}:{operation:parsed.data.operation,operationId:parsed.data.operationId,credentialId:parsed.data.credentialId}
      receipt=await runDeviceCredentialOperation({client,ownerId:auth.device.ownerUserId,projectId,deviceId:auth.device.id,verifyIdentity},operation)
    }
    if (parsed.data.operation === 'credentials' || parsed.data.operation === 'revoke-credential') {
      const vault = credentialStore(client, auth.device.ownerUserId, projectId)
      await verify()
      const credentials=await listProjectCredentials(vault);await verify()
      return Response.json({ projectId, credentials,...(receipt?{receipt}:{}) }, { headers })
    }
    const port = secretRequestStore(client, auth.device.ownerUserId, projectId,undefined,verify)
    if (parsed.data.operation === 'dismiss') await dismissRequestedSecret(port, parsed.data.requestId)
    const requests = parsed.data.operation === 'request' ? await requestSecrets(port, parsed.data.requests) : await listSecretRequests(port)
    await verify()
    return Response.json({ projectId,...(receipt?{receipt}:{}), requests: requests.filter((entry) => entry.target && entry.environment && entry.targetRef), formPath: `/projects/${projectId}#secrets` }, { headers })
  } catch (error) { return Response.json(operationApprovalErrorBody(error) ?? (error instanceof OperationError?{error:error.message}:safeSecretFailure(error)), { status: error instanceof OperationError?error.status:409, headers }) }
}
