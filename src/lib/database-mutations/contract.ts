import { z } from 'zod'
import { deleteIdentifierSchema } from '../database-delete/contract'
import { isSensitiveIdentifier } from '../database-inspection/sensitive'

export const mutationIdentifier = deleteIdentifierSchema
const scalar = z.union([
  z
    .string()
    .max(8000)
    .refine((value) => !value.includes('\0')),
  z
    .number()
    .finite()
    .refine((value) => !Number.isInteger(value) || Number.isSafeInteger(value)),
  z.boolean(),
  z.null(),
])
const key = z
  .record(
    mutationIdentifier,
    z.union([scalar.options[0], scalar.options[1], z.boolean()]),
  )
  .refine(
    (value) => Object.keys(value).length > 0 && Object.keys(value).length <= 8,
  )
const values = z
  .record(mutationIdentifier, scalar)
  .refine(
    (value) =>
      Object.keys(value).length > 0 &&
      Object.keys(value).length <= 32 &&
      Object.keys(value).every(
        (name) =>
          !isSensitiveIdentifier(name) &&
          !/(?:^|_)(?:roles?|permissions?|privileges?|admin|superuser|bypassrls)(?:_|$)/i.test(
            name,
          ),
      ),
    'Informe 1–32 campos de negócio; credenciais e permissões têm canais próprios.',
  )
export const mutationActionSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('insert'),
      table: mutationIdentifier,
      rows: z.array(z.object({ key, values }).strict()).min(1).max(25),
    })
    .strict(),
  z
    .object({
      type: z.literal('update'),
      table: mutationIdentifier,
      rows: z.array(z.object({ key, values }).strict()).min(1).max(25),
    })
    .strict(),
  z
    .object({
      type: z.literal('upsert'),
      table: mutationIdentifier,
      rows: z.array(z.object({ key, values }).strict()).min(1).max(25),
    })
    .strict(),
  z
    .object({
      type: z.literal('delete'),
      table: mutationIdentifier,
      rows: z.array(z.object({ key }).strict()).min(1).max(25),
    })
    .strict(),
])
export type MutationAction = z.infer<typeof mutationActionSchema>
export type MutationCapability = `data.${MutationAction['type']}`
export const mutationOperationSchema = z.enum(['data-plan', 'data-apply'])
export const mutationOptionsSchema = z.discriminatedUnion('operation', [
  z
    .object({
      operation: z.literal('data-plan'),
      environment: z.literal('development'),
      action: mutationActionSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal('data-apply'),
      environment: z.literal('development'),
      planToken: z.string().min(64).max(500_000),
    })
    .strict(),
])
export type MutationOptions = z.infer<typeof mutationOptionsSchema>
const authority = {
  deviceSecret: z.string().min(10).max(256),
  projectId: z.string().uuid(),
  expectedRef: z.string().regex(/^[a-z0-9_-]{1,64}$/),
}
export const mutationRequestSchema = z.discriminatedUnion('operation', [
  mutationOptionsSchema.options[0].extend(authority),
  mutationOptionsSchema.options[1].extend(authority),
])
export type MutationRequest = z.infer<typeof mutationRequestSchema>
export class MutationError extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message)
    this.name = 'MutationError'
  }
}
