import { z } from 'zod'
import { describeEnvironment, requireDevelopment } from '../database-environment/policy'
import { compileJob } from './compile'
import { tableCatalogSql, validateJobTable } from './catalog'
import { jobsRequestSchema, isReadJobOperation, jobIdentifier, jobManifestEntrySchema, type JobsRequest } from './policy'
import { JobsError, type JobsProvider } from './provider'
import { cronCapabilitySql, bootstrapJobsSql, applyJobsSql, listJobsSql, historyJobsSql, mutateJobSql } from './sql'

const capabilitySchema = z.object({ installed: z.boolean(), registry: z.boolean(), timezone: z.string() })
const time = z.string().min(1).max(64)
const listRowSchema = z.object({
  job_id: jobManifestEntrySchema.shape.id, table_name: jobIdentifier, active: z.boolean(), schedule: z.string().max(100).nullable(),
  timezone: z.literal('UTC'), created_at: time, updated_at: time, synchronized: z.boolean(),
})
const historyRowSchema = z.object({
  job_id: jobManifestEntrySchema.shape.id, runid: z.union([z.number().int().nonnegative(), z.string().regex(/^\d+$/)]),
  status: z.string().min(1).max(40), start_time: time.nullable(), end_time: time.nullable(), diagnostic: z.string().max(256).nullable(),
})
const UTC = new Set(['UTC', 'GMT', 'Etc/UTC'])

export function requireJobTarget(record: unknown, linkedRef: string | null, request: Pick<JobsRequest, 'expectedRef' | 'environment' | 'operation'>) {
  const state = describeEnvironment(record, linkedRef)
  if (!state.projectRef || state.projectRef !== request.expectedRef || state.environment !== request.environment) throw new JobsError('Vínculo ou ambiente mudou. Consulte db status antes de usar jobs.')
  if (!isReadJobOperation(request.operation)) requireDevelopment(record, linkedRef, request.expectedRef)
  return state
}

function confirmed<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new JobsError('Resposta de jobs incompatível; a operação não foi confirmada.', 502)
  return parsed.data
}

/** Own-scope fixed catalog reads and transactional declarations. All external
 * calls, including metadata reads before apply, require fresh authority. */
export async function runJobs(provider: JobsProvider, input: JobsRequest) {
  const request = jobsRequestSchema.parse(input)
  const readOnly = isReadJobOperation(request.operation)
  let [capability] = confirmed(z.tuple([capabilitySchema]), await provider.query(cronCapabilitySql, { readOnly: true }))
  if (readOnly && (!capability.installed || !capability.registry)) {
    return { available: false, reason: 'pg_cron ou registro de jobs ainda não configurado neste projeto.', rows: [], hasMore: false, nextOffset: null }
  }
  if (readOnly) {
    const raw = await provider.query(request.operation === 'cron-list'
      ? listJobsSql(request.projectId, request.limit, request.offset, request.jobId)
      : historyJobsSql(request.projectId, request.limit, request.offset, request.jobId), { readOnly: true })
    const rows = request.operation === 'cron-list'
      ? confirmed(z.array(listRowSchema).max(request.limit + 1), raw)
      : confirmed(z.array(historyRowSchema).max(request.limit + 1), raw)
    const hasMore = rows.length > request.limit
    return { available: true, rows: rows.slice(0, request.limit), rowCount: Math.min(rows.length, request.limit), hasMore,
      nextOffset: hasMore && request.offset + request.limit <= 10000 ? request.offset + request.limit : null,
      truncated: hasMore, timezone: capability.timezone, scheduleAvailable: UTC.has(capability.timezone) }
  }
  if (!UTC.has(capability.timezone)) throw new JobsError('pg_cron está configurado fora de UTC. Nenhum job foi alterado.')
  if (request.operation === 'cron-apply') {
    const compiled = []
    for (const job of request.manifest!.jobs) {
      const rows = await provider.query(tableCatalogSql(job.action.table), { readOnly: true })
      if (rows.length !== 1) throw new JobsError(`Tabela public.${job.action.table} não encontrada ou não é única.`)
      try { compiled.push(compileJob(request.projectId, job, validateJobTable(job, rows[0]))) }
      catch { throw new JobsError(`Tabela public.${job.action.table} não atende à política de rotinas: use tabela comum com RLS, chave simples, campos de negócio e dependências suportadas.`) }
    }
    if (!capability.installed || !capability.registry) {
      confirmed(z.tuple([z.object({ ready: z.literal(true) })]), await provider.query(bootstrapJobsSql(), { readOnly: false }));
      [capability] = confirmed(z.tuple([capabilitySchema]), await provider.query(cronCapabilitySql, { readOnly: true }))
      if (!capability.installed || !capability.registry || !UTC.has(capability.timezone)) throw new JobsError('pg_cron não foi confirmado como disponível em UTC. Nenhum job foi aplicado.')
    }
    const [result] = confirmed(z.tuple([z.object({ applied: z.literal(true), job_count: z.literal(compiled.length) })]), await provider.query(applyJobsSql(request.projectId, compiled), { readOnly: false }))
    return { available: true, ...result, jobIds: request.manifest!.jobs.map((job) => job.id) }
  }
  if (!capability.installed || !capability.registry) throw new JobsError('Nenhum registro de jobs está disponível neste projeto.')
  // The strict request schema requires jobId for these exact operations.
  if (request.operation !== 'cron-pause' && request.operation !== 'cron-resume' && request.operation !== 'cron-remove') throw new JobsError('Operação de jobs inválida.')
  const [result] = confirmed(z.tuple([z.object({ applied: z.literal(true) })]), await provider.query(mutateJobSql(request.projectId, request.operation, request.jobId!), { readOnly: false }))
  return { available: true, ...result, jobId: request.jobId }
}
