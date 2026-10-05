import 'server-only'
import { randomUUID } from 'node:crypto'
import { operationAuthorizationContext, operationInputDigest } from './approval-context'
import type { OperationApproval } from './approval-contract'
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { OperationError, capabilitySchema, environmentSchema, operationStates, type OperationCapability, type OperationReceipt } from './contract'

const storedReceiptSchema = z.object({ id: z.string().uuid(), capability: capabilitySchema, environment: environmentSchema,
  state: z.enum(operationStates), updated_at: z.string(), message: z.string(), result: z.record(z.string(), z.unknown()).nullable(),
  lease_expires_at: z.string(), claim_token: z.string().uuid(), input_digest: z.string() })
export function operationReceipt(raw: unknown, now = Date.now()): OperationReceipt {
  const row = storedReceiptSchema.parse(raw)
  const abandoned = ['queued', 'running', 'verifying'].includes(row.state) && Date.parse(row.lease_expires_at) < now
  return { id: row.id, capability: row.capability, environment: row.environment,
    state: abandoned ? 'uncertain' : row.state, updatedAt: row.updated_at,
    message: abandoned ? 'Executor sem confirmação recente. Confira o resultado antes de repetir a operação.' : row.message, result: row.result }
}
export function backendOperationStore(client: SupabaseClient, scope: { ownerId: string; projectId: string; id: string; capability: OperationCapability; input: unknown; review?: OperationApproval['review']; expiresAt?: number }) {
  const token = randomUUID()
  const digest = operationInputDigest(scope.input)
  return {
    ...operationAuthorizationContext(scope),
    async claim(authorization: { policyId: string; revision: string }) {
      const { data, error } = await client.rpc('claim_backend_operation', { p_id: scope.id, p_owner: scope.ownerId, p_project: scope.projectId,
        p_policy: authorization.policyId, p_revision: authorization.revision, p_capability: scope.capability, p_digest: digest, p_token: token })
      if (error || !Array.isArray(data) || !data[0]) throw new OperationError('A operação não pôde ser reservada. Confira a autorização, o limite por hora e o ID já utilizado.', 409)
      const raw = storedReceiptSchema.parse(data[0])
      return { acquired: raw.claim_token === token && raw.state === 'queued', token, receipt: operationReceipt(raw) }
    },
    async update(id: string, claimToken: string, state: OperationReceipt['state'], message: string, result?: Record<string, unknown>): Promise<OperationReceipt> {
      const { data, error } = await client.from('project_backend_operations').update({ state, message, ...(result ? { result } : {}),
        updated_at: new Date().toISOString(), lease_expires_at: new Date(Date.now() + 120_000).toISOString() })
        .eq('id', id).eq('user_id', scope.ownerId).eq('project_id', scope.projectId).eq('claim_token', claimToken)
        .in('state', ['queued', 'running', 'verifying']).gt('lease_expires_at', new Date().toISOString()).select('*').maybeSingle()
      if (error || !data) throw new OperationError('O recibo não pôde ser confirmado. Consulte a operação pelo ID; não repita a alteração.', 503)
      return operationReceipt(data)
    },
  }
}
