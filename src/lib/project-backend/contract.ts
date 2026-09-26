import { z } from 'zod'

export const backendOperationSchema = z.enum(['tables', 'rows', 'query', 'functions', 'function-status', 'jobs', 'job-history', 'job-set-active', 'logs', 'usage', 'users', 'storage'])
export type BackendOperation = z.infer<typeof backendOperationSchema>
export const backendInputSchema = z.object({
  projectId: z.string().uuid(), operation: backendOperationSchema,
  table: z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/i).optional(),
  sql: z.string().trim().min(1).max(12_000).optional(),
  slug: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/).optional(),
  jobId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/).optional(), enabled: z.boolean().optional(),
  expectedRef: z.string().regex(/^[a-z0-9_-]{1,64}$/).optional(),
  environment: z.enum(['development', 'production', 'unknown']).optional(),
  limit: z.number().int().min(1).max(100).default(50), offset: z.number().int().min(0).max(10_000).default(0),
  minutes: z.number().int().min(1).max(1440).default(60),
  source: z.enum(['postgres', 'auth', 'api', 'functions', 'storage', 'realtime']).default('functions'),
  level: z.enum(['all', 'error']).default('all'),
}).strict().superRefine((value, ctx) => {
  const require = (condition: boolean, message: string) => { if (!condition) ctx.addIssue({ code: 'custom', message }) }
  require((value.operation === 'rows') === (value.table !== undefined), 'Tabela é obrigatória somente para abrir registros.')
  require((value.operation === 'query') === (value.sql !== undefined), 'SQL é obrigatório somente no editor.')
  require((value.operation === 'function-status') === (value.slug !== undefined), 'Função é obrigatória somente para consultar seu estado.')
  require(['job-history', 'job-set-active'].includes(value.operation) === (value.jobId !== undefined), 'Job é obrigatório para histórico ou alteração.')
  require((value.operation === 'job-set-active') === (value.enabled !== undefined), 'Estado é obrigatório somente para alterar o job.')
  if (value.operation === 'job-set-active') require(Boolean(value.expectedRef && value.environment && value.environment !== 'unknown'), 'Confirme o ambiente e o banco antes de alterar o agendamento.')
})
export type BackendInput = z.input<typeof backendInputSchema>
export type ParsedBackendInput = z.infer<typeof backendInputSchema>
export interface BackendMetric { name: string; value: number | null; unit?: string; available: boolean; note?: string }
export interface BackendData {
  kind: BackendOperation
  items: Record<string, unknown>[]
  columns?: string[]
  hasMore?: boolean
  nextOffset?: number | null
  total?: number | null
  message?: string
  metrics?: BackendMetric[]
}
export type BackendResult = { ok: true; data: BackendData; observedAt: string; environment: 'development' | 'production' | 'unknown'; projectRef: string }
  | { ok: false; error: string }
