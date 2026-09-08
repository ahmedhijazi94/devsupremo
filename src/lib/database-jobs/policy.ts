import { z } from 'zod'
import { isSensitiveIdentifier } from '../database-inspection/sensitive'

export const jobIdentifier = z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/)
const scalar = z.union([
  z
    .string()
    .max(2000)
    .refine((value) => !value.includes('\0')),
  z.number().finite(),
  z.boolean(),
  z.null(),
])
const where = z.discriminatedUnion('op', [
  z
    .object({ column: jobIdentifier, op: z.literal('eq'), value: scalar })
    .strict(),
  z
    .object({ column: jobIdentifier, op: z.literal('neq'), value: scalar })
    .strict(),
  z.object({ column: jobIdentifier, op: z.literal('is_null') }).strict(),
  z.object({ column: jobIdentifier, op: z.literal('not_null') }).strict(),
  z
    .object({
      column: jobIdentifier,
      op: z.literal('older_than'),
      minutes: z.number().int().min(1).max(525600),
    })
    .strict(),
])
export function validSchedule(value: string): boolean {
  const fields = value.trim().split(/\s+/)
  const ranges = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 6],
  ] as const
  if (fields.length !== 5) return false
  return fields.every((field, index) =>
    field.split(',').every((part) => {
      const match = /^(\*|\d{1,2}(?:-\d{1,2})?)(?:\/(\d{1,2}))?$/.exec(part)
      if (!match) return false
      const [min, max] = ranges[index]!
      const step = match[2] === undefined ? 1 : Number(match[2])
      if (step < 1 || step > max - min + 1) return false
      if (match[1] === '*') return true
      const values = match[1]!.split('-').map(Number)
      return (
        values.every((v) => v >= min && v <= max) &&
        (values.length === 1 || values[0]! <= values[1]!)
      )
    }),
  )
}
const protectedUpdate =
  /^(id|user_id|owner_id|org_id|organization_id|tenant_id|team_id|created_by)$|(?:^|_)(?:roles?|permissions?|privileges?|admin|superuser|bypassrls|can_login|access_level|access_scope)(?:_|$)/
export function jobColumnAllowed(name: string, update = false): boolean {
  return (
    !isSensitiveIdentifier(name) && (!update || !protectedUpdate.test(name))
  )
}
export const jobManifestEntrySchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/),
    schedule: z
      .string()
      .min(9)
      .max(100)
      .refine(
        validSchedule,
        'Cron exige cinco campos UTC, com intervalo mínimo de um minuto.',
      ),
    timezone: z.literal('UTC'),
    action: z
      .object({
        type: z.literal('update'),
        table: jobIdentifier,
        set: z
          .record(jobIdentifier, scalar)
          .refine(
            (value) =>
              Object.keys(value).length >= 1 &&
              Object.keys(value).length <= 8 &&
              Object.keys(value).every((name) => jobColumnAllowed(name, true)),
            'Atualize 1–8 campos de negócio; ownership, permissões e credenciais não são alvos de rotinas.',
          ),
        where: z
          .array(where)
          .min(1)
          .max(8)
          .refine(
            (values) => values.every((value) => jobColumnAllowed(value.column)),
            'Credenciais não são filtros de rotinas.',
          ),
        limit: z.number().int().min(1).max(1000).default(100),
      })
      .strict(),
  })
  .strict()
export const jobsManifestSchema = z
  .object({
    version: z.literal(1),
    jobs: z.array(jobManifestEntrySchema).min(1).max(8),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.jobs.map((job) => job.id)).size === value.jobs.length,
    'IDs de jobs duplicados.',
  )
  .refine(
    (value) => new TextEncoder().encode(JSON.stringify(value)).length <= 32768,
    'Manifesto limitado a 32KB.',
  )
export type JobDefinition = z.infer<typeof jobManifestEntrySchema>
export type JobsManifest = z.infer<typeof jobsManifestSchema>
export const jobOperationSchema = z.enum([
  'cron-list',
  'cron-history',
  'cron-apply',
  'cron-pause',
  'cron-resume',
  'cron-remove',
])
export const jobsRequestSchema = z
  .object({
    deviceSecret: z.string().min(10).max(256),
    projectId: z.string().uuid(),
    operation: jobOperationSchema,
    expectedRef: z.string().regex(/^[a-z0-9_-]{1,64}$/),
    environment: z.enum(['development', 'production', 'unknown']),
    jobId: z
      .string()
      .regex(/^[a-z0-9][a-z0-9_-]{0,39}$/)
      .optional(),
    manifest: jobsManifestSchema.optional(),
    limit: z.number().int().min(1).max(100).default(50),
    offset: z.number().int().min(0).max(10000).default(0),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.operation === 'cron-apply') !== (value.manifest !== undefined))
      context.addIssue({
        code: 'custom',
        message: 'Manifesto obrigatório somente em apply.',
      })
    if (
      ['cron-pause', 'cron-resume', 'cron-remove'].includes(value.operation) &&
      !value.jobId
    )
      context.addIssue({ code: 'custom', message: 'ID do job obrigatório.' })
    if (value.operation === 'cron-apply' && value.jobId)
      context.addIssue({
        code: 'custom',
        message: 'Apply recebe o manifesto completo.',
      })
  })
export type JobsRequest = z.infer<typeof jobsRequestSchema>
export const isReadJobOperation = (operation: JobsRequest['operation']) =>
  operation === 'cron-list' || operation === 'cron-history'
