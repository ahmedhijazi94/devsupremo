import type { NextRequest } from 'next/server'
import { authenticateDeviceSecret } from '@/lib/checkpoint/devices'
import { supabaseCheckpointDeviceStore } from '@/lib/checkpoint/store'
import { boundedJson, InspectionError } from '@/lib/database-inspection/provider'
import { FUNCTION_REQUEST_BYTES, functionOptionsSchema, functionRequestSchema } from '@/lib/edge-functions/contract'
import { FunctionError, FunctionOperationError } from '@/lib/edge-functions/policy'
import { OperationError } from '@/lib/backend-operations/contract'
import { operationApprovalErrorBody } from '@/lib/backend-operations/approval-contract'
import { runAuthorizedFunctions } from '@/lib/edge-functions/server'
import { createServiceClient } from '@/lib/supabase/admin'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60
export async function POST(request: NextRequest): Promise<Response> {
  const headers = { 'Cache-Control': 'no-store' }
  let json: unknown
  try { json = await boundedJson(request, FUNCTION_REQUEST_BYTES) }
  catch (error) { return Response.json({ error: error instanceof InspectionError && error.status === 413 ? 'Payload excede o limite.' : 'JSON inválido.' }, { status: error instanceof InspectionError && error.status === 413 ? 413 : 400, headers }) }
  const parsed = functionRequestSchema.safeParse(json)
  if (!parsed.success) return Response.json({ error: 'Payload de funções inválido.' }, { status: 400, headers })
  const { deviceSecret, projectId, expectedRef, ...fields } = parsed.data
  const options = functionOptionsSchema.parse(fields)
  try {
    const client = createServiceClient()
    const deviceStore = supabaseCheckpointDeviceStore(client)
    const authenticated = await authenticateDeviceSecret(deviceStore, deviceSecret)
    if (!authenticated.ok) return Response.json({ error: 'Dispositivo não autorizado.' }, { status: 401, headers })
    const ownerId = authenticated.device.ownerUserId
    const verifyIdentity = async () => {
      const currentDevice = await authenticateDeviceSecret(deviceStore, deviceSecret)
      if (!currentDevice.ok || currentDevice.device.ownerUserId !== ownerId) throw new FunctionError('Dispositivo não autorizado.', 401)
      return currentDevice.device.ownerUserId
    }
    const result = await runAuthorizedFunctions({ client, ownerId, projectId, expectedRef, deviceId: authenticated.device.id, verifyIdentity }, options)
    return Response.json(result, { headers })
  } catch (error) {
    const approval = operationApprovalErrorBody(error)
    if (approval) return Response.json(approval, { status: 403, headers })
    return Response.json({ error: error instanceof FunctionError || error instanceof OperationError ? error.message : 'Operação de funções não confirmada. Confira o vínculo, o ambiente e as permissões; consulte o status antes de repetir.',
      ...(error instanceof FunctionOperationError ? { code: error.operationState === 'failed' ? 'operation_failed' : 'operation_uncertain', operationId: error.operationId, operationState: error.operationState } : {}) }, { status: error instanceof FunctionError || error instanceof OperationError ? error.status : 409, headers })
  }
}
