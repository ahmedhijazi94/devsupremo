import { z } from 'zod'
import { describeEnvironment } from '@/lib/database-environment/policy'

export const inspectionOperationSchema = z.enum([
  'inspect',
  'query',
  'logs',
  'report',
])
export const inspectionOptionsSchema = z
  .object({
    operation: inspectionOperationSchema,
    expectedRef: z
      .string()
      .regex(/^[a-z0-9_-]+$/)
      .max(64),
    environment: z.enum(['development', 'production', 'unknown']),
    sql: z.string().min(1).max(12_000).optional(),
    table: z
      .string()
      .regex(/^[a-z_][a-z0-9_]*$/i)
      .max(63)
      .optional(),
    limit: z.number().int().min(1).max(200).default(50),
    offset: z.number().int().min(0).max(10_000).default(0),
    minutes: z.number().int().min(1).max(1440).default(60),
    source: z
      .enum(['postgres', 'auth', 'api', 'functions', 'storage', 'realtime'])
      .default('postgres'),
    level: z.enum(['all', 'error']).default('all'),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.operation === 'query') !== (value.sql !== undefined)) {
      context.addIssue({
        code: 'custom',
        message: 'SQL é obrigatório apenas para query.',
      })
    }
    if (value.table && value.operation !== 'inspect') {
      context.addIssue({
        code: 'custom',
        message: 'Tabela é aceita apenas em inspect.',
      })
    }
  })
export type InspectionOptions = z.infer<typeof inspectionOptionsSchema>
export const inspectionRequestSchema = inspectionOptionsSchema.safeExtend({
  deviceSecret: z.string().min(10).max(256),
  projectId: z.string().uuid(),
})

/** Environment is an expectation, never client-supplied authority. Unknown
 * linked projects may be read by their owner, and are never reclassified as dev. */
export function requireReadTarget(
  record: unknown,
  linkedRef: string | null,
  options: InspectionOptions,
) {
  const state = describeEnvironment(record, linkedRef)
  if (
    !state.projectRef ||
    state.projectRef !== options.expectedRef ||
    state.environment !== options.environment
  ) {
    throw new Error(
      'Vínculo ou ambiente mudou. Consulte db status antes de ler os dados.',
    )
  }
  return state
}
