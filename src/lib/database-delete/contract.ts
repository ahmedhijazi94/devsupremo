import { z } from 'zod'

export const deleteIdentifierSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,62}$/)
export const deleteTargetSchema = z.object({
  table: deleteIdentifierSchema,
  key: z.record(deleteIdentifierSchema, z.union([z.string().max(1000), z.number().finite(), z.boolean()]))
    .refine(value => Object.keys(value).length > 0 && Object.keys(value).length <= 8, 'Informe a chave primária completa (até oito colunas).'),
}).strict()
export const deleteTargetsSchema = z.array(deleteTargetSchema).min(1).max(25)
export type DeleteTarget = z.infer<typeof deleteTargetSchema>
export const deleteOperationSchema = z.enum(['data-delete-plan', 'data-delete-apply'])
export const deleteOptionsSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('data-delete-plan'), environment: z.literal('development'), targets: deleteTargetsSchema }).strict(),
  z.object({ operation: z.literal('data-delete-apply'), environment: z.literal('development'),
    planToken: z.string().min(64).max(500_000), authorization: z.string().trim().min(8).max(1000) }).strict(),
])
export type DeleteOptions = z.infer<typeof deleteOptionsSchema>
const requests = deleteOptionsSchema.options.map(schema => schema.extend({
  deviceSecret: z.string().min(10).max(256), projectId: z.string().uuid(),
  expectedRef: z.string().regex(/^[a-z0-9_-]{1,64}$/),
}))
export const deleteRequestSchema = z.discriminatedUnion('operation', [requests[0]!, requests[1]!])
export type DeleteRequest = z.infer<typeof deleteRequestSchema>

const responseScope = { projectId: z.string().uuid(), projectRef: z.string().regex(/^[a-z0-9_-]{1,64}$/),
  environment: z.literal('development'), observedAt: z.iso.datetime() }
export const deleteResponseSchema = z.discriminatedUnion('operation', [
  z.object({ ...responseScope, operation: z.literal('data-delete-plan'), readOnly: z.literal(true),
    data: z.object({ planToken: z.string().min(64).max(500_000), planId: z.string().uuid(), expiresAt: z.iso.datetime(),
      targets: deleteTargetsSchema, impactCount: z.number().int().min(1).max(25) }).strict() }).strict(),
  z.object({ ...responseScope, operation: z.literal('data-delete-apply'), readOnly: z.literal(false),
    data: z.object({ planId: z.string().uuid(), deletedCount: z.number().int().min(1).max(25), verified: z.literal(true) }).strict() }).strict(),
])
export type DeleteResponse = z.infer<typeof deleteResponseSchema>

export class DataDeleteError extends Error {
  constructor(message: string, readonly status = 409) { super(message); this.name = 'DataDeleteError' }
}

export class DataDeleteOperationError extends DataDeleteError {
  constructor(readonly operationId: string, readonly operationState: 'uncertain' | 'failed' | 'running') {
    super(`Exclusão ${operationState === 'failed' ? 'interrompida antes do envio' : 'ainda não confirmada'}. Consulte o recibo ${operationId} antes de preparar outro plano.`, 409)
    this.name = 'DataDeleteOperationError'
  }
}
