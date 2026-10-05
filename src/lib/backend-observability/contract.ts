import { z } from 'zod'

export const usageMetricNames = ['Tamanho do banco', 'Conexões atuais', 'Usuários cadastrados', 'Tabelas públicas', 'Registros estimados', 'Arquivos armazenados', 'Armazenamento estimado', 'Operações do motor na última hora'] as const
export const usageMetricNameSchema = z.enum(usageMetricNames)
export const usageLimitsSchema = z.array(z.object({ metric: usageMetricNameSchema, maximum: z.number().finite().positive().max(Number.MAX_SAFE_INTEGER) }).strict()).max(8)
  .refine(items => new Set(items.map(item => item.metric)).size === items.length, 'Cada indicador pode ter apenas um limite.')
export const usageScopeSchema = z.object({ projectId: z.string().uuid(), expectedRef: z.string().regex(/^[a-z0-9_-]{1,64}$/), environment: z.enum(['development', 'production']) }).strict()
export const usageReadSchema = usageScopeSchema.extend({ days: z.number().int().min(1).max(30).default(7) }).strict()
export const usageSettingsSchema = usageScopeSchema.extend({ limits: usageLimitsSchema }).strict()
export const usageMetricSchema = z.object({ name: z.string().max(120), value: z.number().finite().nonnegative().nullable(), available: z.boolean(), unit: z.string().max(30).optional(), note: z.string().max(1000).optional() }).strict()
  .refine(value => value.available === (value.value !== null), 'Ausência de leitura precisa ser explícita.')
export const usageSnapshotSchema = z.object({ observedAt: z.iso.datetime({ offset: true }), metrics: z.array(usageMetricSchema).max(16) }).strict()
export type UsageSnapshot = z.infer<typeof usageSnapshotSchema>
export type UsageLimit = z.infer<typeof usageLimitsSchema>[number]
export interface UsageReport {
  projectRef: string; environment: 'development' | 'production'; current: UsageSnapshot; history: UsageSnapshot[]; limits: UsageLimit[]
  alerts: Array<{ metric: UsageLimit['metric']; maximum: number; value: number | null; state: 'within_limit' | 'limit_reached' | 'unavailable' }>
  engineQuota: { maximum: number | null; enabled: boolean | null; note: string }
  historyAvailable: boolean; historyMessage: string; providerQuotasAvailable: false
}
export type UsageResult = { ok: true; report: UsageReport } | { ok: false; error: string }
