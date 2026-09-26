import { z } from 'zod'
import { describeEnvironment } from '../database-environment/policy'
import { applyFunctionJobsSql, bootstrapFunctionJobsSql, functionHistoryJobsSql } from './function-sql'
import { scheduledFunctionSlug } from './function-contract'
import { compileJob } from './compile'
import { tableCatalogSql, validateJobTable } from './catalog'
import { jobsRequestSchema, isReadJobOperation, isFunctionJob, jobIdentifier, jobManifestEntrySchema, type JobsRequest } from './policy'
import { JobsError, type JobsProvider } from './provider'
import { cronCapabilitySql, bootstrapJobsSql, applyJobsSql, listJobsSql, historyJobsSql, mutateJobSql, begin } from './sql'

const capabilitySchema = z.object({ installed: z.boolean(), registry: z.boolean(), timezone: z.string(), functions: z.boolean().optional() })
const time = z.string().min(1).max(64)
const listRowSchema = z.object({
  job_id: jobManifestEntrySchema.shape.id, table_name: z.union([jobIdentifier, scheduledFunctionSlug]), type: z.enum(['function', 'update']).optional(), target: z.union([jobIdentifier, scheduledFunctionSlug]).optional(), active: z.boolean(), schedule: z.string().max(100).nullable(),
  timezone: z.literal('UTC'), created_at: time, updated_at: time, synchronized: z.boolean(),
})
const historyRowSchema = z.object({
  job_id: jobManifestEntrySchema.shape.id, runid: z.union([z.number().int().nonnegative(), z.string().regex(/^\d+$/)]),
  status: z.string().min(1).max(40), start_time: time.nullable(), end_time: time.nullable(), diagnostic: z.string().max(256).nullable(), http_status: z.enum(['not_dispatched', 'pending_response', 'response_expired', 'transport_failed', 'http_succeeded', 'http_failed']).nullable().optional(), http_status_code: z.number().int().min(100).max(599).nullable().optional(), request_id: z.union([z.number().int(), z.string().regex(/^\d+$/)]).nullable().optional(), invocation_id: z.string().uuid().nullable().optional(),
})
const UTC = new Set(['UTC', 'GMT', 'Etc/UTC'])

export function requireJobTarget(record: unknown, linkedRef: string | null, request: Pick<JobsRequest, 'expectedRef' | 'environment' | 'operation'>) {
  const state = describeEnvironment(record, linkedRef)
  if (!state.projectRef || state.projectRef !== request.expectedRef || state.environment !== request.environment) throw new JobsError('Vínculo ou ambiente mudou. Consulte db status antes de usar jobs.')
  if (!isReadJobOperation(request.operation) && state.environment === 'unknown') throw new JobsError('Jobs exigem ambiente development ou production confirmado pelo Supremo.')
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
      : (capability.functions ? functionHistoryJobsSql : historyJobsSql)(request.projectId, request.limit, request.offset, request.jobId), { readOnly: true })
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
    const functionJobs = request.manifest!.jobs.filter(isFunctionJob)
    const functionVersions = new Map<string, Awaited<ReturnType<NonNullable<JobsProvider['functionInfo']>>>>()
    for (const job of request.manifest!.jobs) {
      if (isFunctionJob(job)) {
        if (!provider.functionInfo || !provider.prepareFunctionSigner) throw new JobsError('Este canal ainda não suporta agendamento de funções.')
        if (!functionVersions.has(job.action.slug)) functionVersions.set(job.action.slug, await provider.functionInfo(job.action.slug))
        continue
      }
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
    if (functionJobs.length) {
      if (!capability.functions) confirmed(z.tuple([z.object({ ready: z.literal(true) })]), await provider.query(bootstrapFunctionJobsSql(), { readOnly: false }))
      for (const [slug, before] of functionVersions) {
        await provider.prepareFunctionSigner!(request.projectId, slug)
        const after = await provider.functionInfo!(slug)
        if (before.id !== after.id || before.version !== after.version) throw new JobsError('A função mudou durante a configuração. Revalide o manifesto antes de ativar o job.')
      }
    }
    const count = request.manifest!.jobs.length
    const sql = !functionJobs.length ? applyJobsSql(request.projectId, compiled) : `${begin} ${compiled.length ? applyJobsSql(request.projectId, compiled, false) : ''} ${applyFunctionJobsSql(request.projectId, request.expectedRef, functionJobs, false)} COMMIT; SELECT true AS applied,${count} AS job_count;`
    const [result] = confirmed(z.tuple([z.object({ applied: z.literal(true), job_count: z.literal(count) })]), await provider.query(sql, { readOnly: false }))
    return { available: true, ...result, jobIds: request.manifest!.jobs.map((job) => job.id), ...(functionJobs.length ? { deliveryVerified: false, functionAuthentication: 'hmac-sha256', httpResponsesRetainedHours: 6 } : {}) }
  }
  if (!capability.installed || !capability.registry) throw new JobsError('Nenhum registro de jobs está disponível neste projeto.')
  // The strict request schema requires jobId for these exact operations.
  if (request.operation !== 'cron-pause' && request.operation !== 'cron-resume' && request.operation !== 'cron-remove') throw new JobsError('Operação de jobs inválida.')
  if (request.operation === 'cron-resume' && capability.functions) {
    const [job] = confirmed(z.tuple([listRowSchema]), await provider.query(listJobsSql(request.projectId, 1, 0, request.jobId), { readOnly: true }))
    if (job.type === 'function') {
      if (!provider.functionInfo || !provider.prepareFunctionSigner) throw new JobsError('Este canal ainda não suporta agendamento de funções.')
      const before = await provider.functionInfo(job.table_name)
      await provider.prepareFunctionSigner(request.projectId, job.table_name)
      const after = await provider.functionInfo(job.table_name)
      if (before.id !== after.id || before.version !== after.version) throw new JobsError('A função mudou durante a retomada. Revalide o manifesto.')
    }
  }
  const [result] = confirmed(z.tuple([z.object({ applied: z.literal(true) })]), await provider.query(mutateJobSql(request.projectId, request.operation, request.jobId!), { readOnly: false }))
  return { available: true, ...result, jobId: request.jobId }
}
