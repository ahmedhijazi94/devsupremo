import { z } from 'zod'
import { mutationOptionsSchema } from '../database-mutations/contract'
import { authOptionsSchema } from '../database-admin/options'
import { functionOptionsSchema } from '../edge-functions/contract'
import { jobsRequestSchema } from '../database-jobs/policy'
const scope = { projectId: z.string().uuid(), expectedRef: z.string().regex(/^[a-z0-9_-]{1,64}$/), operationId: z.string().uuid() }
export const backendAdministrationSchema = z.discriminatedUnion('kind', [
  z.object({ ...scope, kind: z.literal('data'), options: mutationOptionsSchema }).strict(),
  z.object({ ...scope, kind: z.literal('auth'), options: authOptionsSchema }).strict(),
  z.object({ ...scope, kind: z.literal('function'), options: functionOptionsSchema }).strict(),
  z.object({ ...scope, kind: z.literal('job'), options: z.object(jobsRequestSchema.shape).omit({ deviceSecret: true, projectId: true, expectedRef: true }).strict() }).strict(),
])
export type BackendAdministrationInput = z.input<typeof backendAdministrationSchema>
export type AdministrationResult = { ok: true; data: unknown } | { ok: false; error: string }
export const dataEditorInputSchema = z.object({ projectId: z.string().uuid(), expectedRef: scope.expectedRef,
  type: z.enum(['insert', 'update', 'upsert', 'delete']), table: z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/),
  keyText: z.string().min(2).max(8000), valuesText: z.string().max(40000) }).strict()
export const dataImportInputSchema = z.object({ projectId: z.string().uuid(), expectedRef: scope.expectedRef,
  table: z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/), type: z.enum(['insert', 'update', 'upsert']), rowsText: z.string().min(2).max(100_000) }).strict()
