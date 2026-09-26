import { z } from 'zod'
import { backendInputSchema, type BackendData, type BackendInput, type BackendMetric, type ParsedBackendInput } from './contract'
import { runInspection } from '../database-inspection/service'
import { InspectionError, type InspectionProvider } from '../database-inspection/provider'
import { diagnosticsSql } from '../database-inspection/schema'
import type { FunctionResponse } from '../edge-functions/contract'

export interface BackendTarget { projectRef: string; environment: 'development' | 'production' | 'unknown' }
export interface BackendPorts {
  inspection: InspectionProvider
  functions(operation: 'functions-list' | 'functions-status', slug?: string): Promise<FunctionResponse>
  jobs(operation: 'cron-list' | 'cron-history' | 'cron-pause' | 'cron-resume', input: ParsedBackendInput): Promise<unknown>
  users(limit: number, offset: number): Promise<unknown>
}
const records = z.array(z.record(z.string(), z.unknown())).max(1000)
const pageSchema = z.object({ rows: records, columns: z.array(z.string()).optional(), hasMore: z.boolean().optional(), nextOffset: z.number().nullable().optional() })

function page(kind: BackendData['kind'], raw: unknown): BackendData {
  const value = pageSchema.parse(raw)
  return { kind, items: value.rows, ...(value.columns ? { columns: value.columns } : {}),
    ...(value.hasMore !== undefined ? { hasMore: value.hasMore } : {}),
    ...(value.nextOffset !== undefined ? { nextOffset: value.nextOffset } : {}) }
}
function slice(kind: BackendData['kind'], rows: Record<string, unknown>[], input: ParsedBackendInput): BackendData {
  const hasMore = rows.length > input.limit
  return { kind, items: rows.slice(0, input.limit), hasMore, nextOffset: hasMore && input.offset + input.limit <= 10000 ? input.offset + input.limit : null }
}

// Fixed reads expose metrics only; user SQL never gets access to auth/storage.
export const usageCountsSql = `SELECT (SELECT count(*) FROM auth.users) AS users,
 (SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p')) AS tables,
 (SELECT COALESCE(sum(n_live_tup),0) FROM pg_catalog.pg_stat_user_tables WHERE schemaname='public') AS approximate_rows`
export const storageUsageSql = `SELECT count(*) AS objects, COALESCE(sum(CASE WHEN metadata->>'size' ~ '^[0-9]{1,18}$' THEN (metadata->>'size')::bigint ELSE 0 END),0) AS storage_bytes FROM storage.objects`
function metric(name: string, row: Record<string, unknown> | undefined, key: string, unit?: string, note?: string): BackendMetric {
  const raw = row?.[key]
  const number = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+(?:\.\d+)?$/.test(raw) ? Number(raw) : null
  const value = number !== null && Number.isFinite(number) && number >= 0 ? number : null
  return { name, value, available: value !== null, ...(unit ? { unit } : {}), ...(note ? { note } : {}) }
}
async function usage(provider: InspectionProvider): Promise<BackendData> {
  const reads = await Promise.allSettled([provider.query(diagnosticsSql), provider.query(usageCountsSql), provider.query(storageUsageSql)])
  const rows = reads.map(result => result.status === 'fulfilled' ? records.safeParse(result.value) : null)
  const [database, counts, storage] = rows.map(result => result?.success ? result.data[0] : undefined)
  return { kind: 'usage', items: [], metrics: [
    metric('Tamanho do banco', database, 'database_bytes', 'bytes'), metric('Conexões atuais', database, 'connections'),
    metric('Usuários cadastrados', counts, 'users'), metric('Tabelas públicas', counts, 'tables'),
    metric('Registros estimados', counts, 'approximate_rows', undefined, 'Estimativa do PostgreSQL, atualizada pelas estatísticas do banco.'),
    metric('Arquivos armazenados', storage, 'objects'), metric('Armazenamento estimado', storage, 'storage_bytes', 'bytes', 'Soma dos tamanhos informados nos metadados dos arquivos.'),
    { name: 'Faturamento e cotas do plano', value: null, available: false, note: 'Não disponibilizados por este relatório. Valores indisponíveis não significam consumo zero.' },
  ], message: 'Retrato atual do banco conectado. As métricas disponíveis não substituem o relatório de faturamento do provedor.' }
}

export async function runBackend(ports: BackendPorts, target: BackendTarget, raw: BackendInput): Promise<BackendData> {
  const input = backendInputSchema.parse(raw)
  const kind = input.operation
  if (input.expectedRef && input.expectedRef !== target.projectRef || input.environment && input.environment !== target.environment) throw new InspectionError('O banco ou ambiente mudou. Atualize o painel.', 409)
  if (['tables', 'rows', 'query', 'logs'].includes(kind)) {
    const operation = kind === 'tables' ? 'inspect' : kind === 'logs' ? 'logs' : 'query'
    const sql = kind === 'rows' ? `SELECT * FROM public."${input.table}"` : input.sql
    return page(kind, await runInspection(ports.inspection, { operation, expectedRef: target.projectRef, environment: target.environment,
      limit: input.limit, offset: input.offset, minutes: input.minutes, source: input.source, level: input.level, ...(sql ? { sql } : {}) }))
  }
  if (kind === 'functions' || kind === 'function-status') {
    const result = await ports.functions(kind === 'functions' ? 'functions-list' : 'functions-status', input.slug)
    const rows = result.operation === 'functions-list' ? [...result.data.functions].sort((a,b) => a.slug.localeCompare(b.slug)) : result.operation === 'functions-status' && result.data.function ? [result.data.function] : []
    return { ...slice(kind, rows.slice(input.offset), input), total: rows.length }
  }
  if (kind === 'users') {
    const result = z.object({ users: records, mayHaveMore: z.boolean() }).parse(await ports.users(input.limit, input.offset))
    return { kind, items: result.users, hasMore: result.mayHaveMore, nextOffset: result.mayHaveMore && input.offset + input.limit <= 10000 ? input.offset + input.limit : null }
  }
  if (kind === 'storage') {
    const rows = records.parse(await ports.inspection.query(`SELECT id,name,public,created_at,updated_at,file_size_limit,allowed_mime_types FROM storage.buckets ORDER BY id LIMIT ${input.limit + 1} OFFSET ${input.offset}`))
    return slice(kind, rows, input)
  }
  if (kind === 'usage') return usage(ports.inspection)
  const operation = kind === 'jobs' ? 'cron-list' : kind === 'job-history' ? 'cron-history' : input.enabled ? 'cron-resume' : 'cron-pause'
  if (kind === 'job-set-active' && target.environment === 'unknown') throw new InspectionError('Agendamentos exigem um ambiente confirmado pelo Supremo.', 409)
  const rawJobs = await ports.jobs(operation, input)
  if (kind === 'job-set-active') {
    z.object({ available: z.literal(true), applied: z.literal(true), jobId: z.literal(input.jobId!) }).parse(rawJobs)
    return { kind, items: [], message: input.enabled ? 'Agendamento ativado.' : 'Agendamento pausado.' }
  }
  const result = z.object({ available: z.boolean(), rows: records, hasMore: z.boolean().optional(), nextOffset: z.number().nullable().optional() }).parse(rawJobs)
  return { ...page(kind, result), items: result.rows.map(row => ({ ...row, jobId: row.job_id, ...(kind === 'jobs' ? { type: row.type ?? 'update', target: row.target ?? row.table_name } : {}) })),
    ...(!result.available ? { message: 'Nenhum agendador configurado. Peça ao agente para criar a primeira rotina.' } : {}) }
}
