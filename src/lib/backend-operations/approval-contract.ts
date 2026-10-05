import { z } from 'zod'
import { capabilitySchema, environmentSchema, OperationError } from './contract'

export const approvalStatusSchema = z.enum(['pending', 'approved', 'consumed', 'rejected', 'revoked'])
export const approvalReviewSchema = z.array(z.object({ label: z.string().max(240), value: z.string().max(2000) }).strict()).max(100)
export const approvalSchema = z.object({
  id: z.uuid(), operationId: z.uuid(), capability: capabilitySchema, environment: environmentSchema,
  resource: z.string(), rows: z.number().int().nullable(), projectRef: z.string(),
  inputDigest: z.string().regex(/^[a-f0-9]{64}$/), policyRevision: z.uuid(), deviceId: z.uuid().nullable(),
  status: approvalStatusSchema, expiresAt: z.string(), createdAt: z.string(), review: approvalReviewSchema,
}).strict()
export type OperationApproval = z.infer<typeof approvalSchema>
export class OperationApprovalRequired extends OperationError {
  readonly code = 'operation_approval_required'
  constructor(readonly operationId: string) {
    super(`A operação ${operationId} aguarda aprovação pontual do dono na seção Automação do projeto. Depois da aprovação, retome o mesmo pedido e ID. Nenhuma alteração foi enviada.`, 403)
    this.name = 'OperationApprovalRequired'
  }
}
export function operationApprovalErrorBody(error: unknown) {
  return error instanceof OperationApprovalRequired ? { error: error.message, code: error.code, operationId: error.operationId } : null
}
