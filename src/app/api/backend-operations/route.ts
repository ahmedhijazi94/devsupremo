import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { createServiceClient } from '@/lib/supabase/admin'
import { authenticateDeviceSecret } from '@/lib/checkpoint/devices'
import { supabaseCheckpointDeviceStore } from '@/lib/checkpoint/store'
import { getProject } from '@/lib/projects/repository'
import { readEnvironment } from '@/lib/database-environment/store'
import { describeEnvironment } from '@/lib/database-environment/policy'
import { boundedJson, InspectionError } from '@/lib/database-inspection/provider'
import { OperationError } from '@/lib/backend-operations/contract'
import { operationApprovalErrorBody } from '@/lib/backend-operations/approval-contract'
import { authorizeProjectOperation, readOperationPolicy } from '@/lib/backend-operations/server'
import { assertSamePolicy } from '@/lib/backend-operations/policy'
import { operationReceipt } from '@/lib/backend-operations/store'
import { engineCatalog } from '@/lib/backend-operations/catalog'
import { storageOptionsSchema } from '@/lib/project-storage/contract'
import { runAuthorizedStorage } from '@/lib/project-storage/server'
import { IntegrationError, integrationOptionsSchema } from '@/lib/integrations/contract'
import { runAuthorizedIntegration, listIntegrationSessions } from '@/lib/integrations/server'
import { listProviderConnections } from '@/lib/provider-connections/server'
import { connectionProposalInputSchema } from '@/lib/provider-connections/proposals-contract'
import { proposeIntegrationConnection, listIntegrationConnectionProposals } from '@/lib/provider-connections/proposals'
import { usageReadSchema } from '@/lib/backend-observability/contract'
import { readAuthorizedUsage } from '@/lib/backend-observability/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const identity = { deviceSecret: z.string().min(10).max(256), projectId: z.string().uuid() }
const requestSchema = z.discriminatedUnion('operation', [
  z.object({ ...identity, operation: z.literal('catalog') }).strict(),
  z.object({ ...identity, operation: z.literal('policy') }).strict(),
  z.object({ ...identity, operation: z.literal('operation-status'), id: z.string().uuid() }).strict(),
  z.object({ ...identity, operation: z.literal('storage'), options: storageOptionsSchema }).strict(),
  z.object({ ...identity, operation: z.literal('integration'), options: integrationOptionsSchema }).strict(),
  z.object({ ...identity, operation: z.literal('integration-propose'), options: connectionProposalInputSchema }).strict(),
  z.object({ ...identity, operation: z.literal('integration-status') }).strict(),
  z.object({ ...identity, operation: z.literal('usage'), options: usageReadSchema }).strict(),
])
export async function POST(request: NextRequest): Promise<Response> {
  const headers = { 'Cache-Control': 'no-store' }
  let json: unknown
  try { json = await boundedJson(request, 900_000) }
  catch (error) { return Response.json({ error: error instanceof InspectionError && error.status === 413 ? 'Pedido excede o limite.' : 'JSON inválido.' }, { status: error instanceof InspectionError && error.status === 413 ? 413 : 400, headers }) }
  try {
    const parsed = requestSchema.safeParse(json)
    if (!parsed.success) return Response.json({ error: 'Pedido inválido.' }, { status: 400, headers })
    const body = parsed.data, client = createServiceClient()
    const auth = await authenticateDeviceSecret(supabaseCheckpointDeviceStore(client), body.deviceSecret)
    if (!auth.ok) throw new OperationError('Dispositivo não autorizado.', 401)
    const ownerId = auth.device.ownerUserId
    const verifyIdentity = async () => { const fresh = await authenticateDeviceSecret(supabaseCheckpointDeviceStore(client), body.deviceSecret); return fresh.ok ? fresh.device.ownerUserId : '' }
    const project = await getProject(ownerId, body.projectId)
    const authority = { client, ownerId, projectId: body.projectId, deviceId: auth.device.id, verifyIdentity }
    let data: unknown
    if (body.operation === 'catalog') data = engineCatalog()
    else if (body.operation === 'policy') {
      const state = describeEnvironment(await readEnvironment(client, project.id), project.supabase_project_ref)
      const environment = state.environment === 'development' ? 'development' : state.environment === 'production' ? 'production' : 'unknown'
      data = { environment, policy: environment === 'unknown' ? null : await readOperationPolicy(client, ownerId, project.id, environment) }
    } else if (body.operation === 'operation-status') {
      const receipt = await client.from('project_backend_operations').select('*').eq('id', body.id).eq('user_id', ownerId).eq('project_id', project.id).maybeSingle()
      if (receipt.error || !receipt.data) throw new OperationError('Operação não encontrada neste projeto.', 404)
      // Status remains available for reconciliation after a permission change.
      // Provider payloads require their own current read authorization; they
      // must not be disclosed through a generic receipt lookup.
      data = { ...operationReceipt(receipt.data), result: null, resultOmitted: true }
    } else if (body.operation === 'usage') {
      if (body.options.projectId !== project.id) throw new OperationError('O pedido de uso pertence a outro projeto.', 403)
      data = await readAuthorizedUsage(authority, body.options)
    } else if (body.operation === 'storage') data = await runAuthorizedStorage(authority, body.options)
    else if (body.operation === 'integration') data = await runAuthorizedIntegration(authority, body.options)
    else if (body.operation === 'integration-propose') data = await proposeIntegrationConnection(authority, body.options)
    else {
      const state = describeEnvironment(await readEnvironment(client, project.id), project.supabase_project_ref)
      if (state.environment !== 'development' && state.environment !== 'production') throw new OperationError('Confirme o ambiente conectado antes de consultar integrações.', 409)
      const scope = { ...authority, environment: state.environment as 'development' | 'production' }
      const binding = await authorizeProjectOperation(scope, 'integrations.read')
      const connections = (await listProviderConnections(authority)).filter(connection => connection.environment === state.environment)
      const connectionIds = new Set(connections.map(connection => connection.id))
      const sessions = (await listIntegrationSessions(authority)).filter(session => connectionIds.has(session.connectionId))
      const proposals = (await listIntegrationConnectionProposals(authority)).filter(proposal => proposal.input.environment === state.environment)
      assertSamePolicy(binding, await authorizeProjectOperation(scope, 'integrations.read'))
      data = { connections, sessions, proposals }
    }
    if (await verifyIdentity() !== ownerId) throw new OperationError('Dispositivo revogado durante a consulta.', 401)
    await getProject(ownerId, body.projectId)
    return Response.json({ projectId: project.id, operation: body.operation, data, observedAt: new Date().toISOString(), untrustedData: true }, { headers })
  } catch (error) {
    const approval = operationApprovalErrorBody(error)
    if (approval) return Response.json(approval, { status: 403, headers })
    return Response.json({ error: error instanceof OperationError || error instanceof IntegrationError ? error.message : 'Operação não confirmada. Confira o projeto, a autorização e as migrations do motor.' }, { status: error instanceof OperationError ? error.status : error instanceof IntegrationError ? error.httpStatus ?? 409 : 409, headers })
  }
}
