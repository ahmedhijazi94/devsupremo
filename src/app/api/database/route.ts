import { waitForAnonymousAuth } from '@/lib/database-environment/auth-readiness'
import type { NextRequest } from 'next/server'
import { createServiceClient } from '@/lib/supabase/admin'
import { authenticateDeviceSecret } from '@/lib/checkpoint/devices'
import { supabaseCheckpointDeviceStore } from '@/lib/checkpoint/store'
import { getProject, getSupabaseCredentials } from '@/lib/projects/repository'
import { readEnvironment } from '@/lib/database-environment/store'
import { databaseRequestSchema, describeEnvironment } from '@/lib/database-environment/policy'
import { runDatabaseOperation } from '@/lib/database-environment/service'
import { z } from 'zod'
import { inspectionRequestSchema, inspectionOptionsSchema, requireReadTarget } from '@/lib/database-inspection/policy'
import { boundedJson, InspectionError, redactInspection, supabaseInspectionProvider } from '@/lib/database-inspection/provider'
import { runInspection } from '@/lib/database-inspection/service'
import { UnsafeSqlError } from '@/lib/database/sql-guard'
import { jobsRequestSchema, jobOperationSchema, isReadJobOperation, type JobsRequest } from '@/lib/database-jobs/policy'
import { JobsError, supabaseJobsProvider } from '@/lib/database-jobs/provider'
import { requireJobTarget, runJobs } from '@/lib/database-jobs/service'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const isJobsRequest = (body: { operation: string }): body is JobsRequest => jobOperationSchema.safeParse(body.operation).success

export async function POST(request: NextRequest): Promise<Response> {
  const headers = { 'Cache-Control': 'no-store' }
  let json: unknown
  try { json = await boundedJson(request, 1_000_000) }
  catch (error) { return Response.json({ error: error instanceof InspectionError && error.status === 413 ? 'Payload excede o limite.' : 'JSON inválido.' }, { status: error instanceof InspectionError && error.status === 413 ? 413 : 400, headers }) }
  const parsed = z.union([databaseRequestSchema, inspectionRequestSchema, jobsRequestSchema]).safeParse(json)
  if (!parsed.success) return Response.json({ error: 'Payload inválido.' }, { status: 400 })
  const body = parsed.data
  const client = createServiceClient()
  const auth = await authenticateDeviceSecret(supabaseCheckpointDeviceStore(client), body.deviceSecret)
  if (!auth.ok) return Response.json({ error: 'Dispositivo não autorizado.' }, { status: 401 })
  try {
    const ownerId = auth.device.ownerUserId
    const verify = async () => {
      const project = await getProject(ownerId, body.projectId)
      return { record: await readEnvironment(client, project.id), linkedRef: project.supabase_project_ref }
    }
    const state = await verify()
    if (body.operation === 'status') {
      return Response.json(describeEnvironment(state.record, state.linkedRef), { headers: { 'Cache-Control': 'no-store' } })
    }
    if (isJobsRequest(body)) {
      const identity = requireJobTarget(state.record, state.linkedRef, body)
      const secrets = [body.deviceSecret]
      const authorizeJobs = async () => {
        const freshAuth = await authenticateDeviceSecret(supabaseCheckpointDeviceStore(client), body.deviceSecret)
        if (!freshAuth.ok || freshAuth.device.ownerUserId !== ownerId) throw new JobsError('Dispositivo não autorizado.', 401)
        const project = await getProject(ownerId, body.projectId)
        requireJobTarget(await readEnvironment(client, project.id), project.supabase_project_ref, body)
        return project
      }
      const provider = supabaseJobsProvider(async (readOnly) => {
        if (!readOnly && isReadJobOperation(body.operation)) throw new JobsError('Esta operação de jobs permite somente leitura.')
        const project = await authorizeJobs()
        const credentials = await getSupabaseCredentials(ownerId, project)
        if (credentials.projectRef !== identity.projectRef) throw new JobsError('Vínculo do banco mudou. Consulte db status.')
        const current = await authorizeJobs()
        if (current.supabase_account_id !== project.supabase_account_id) throw new JobsError('Conta do banco mudou. Consulte db status.')
        secrets.push(credentials.token)
        return credentials
      })
      const evidence = redactInspection(await runJobs(provider, body), secrets)
      return Response.json({ projectId: body.projectId, projectRef: identity.projectRef, environment: identity.environment,
        operation: body.operation, readOnly: isReadJobOperation(body.operation), observedAt: new Date().toISOString(),
        untrustedData: true, data: evidence.value, redacted: evidence.redacted, truncated: evidence.truncated,
        limits: { rows: body.limit, offset: body.offset, maxOffset: 10000, maxJobs: 8, responseBytes: 512000,
          statementTimeoutMs: isReadJobOperation(body.operation) ? 8000 : 30000 },
      }, { headers })
    }
    if ('environment' in body) {
      const options = inspectionOptionsSchema.parse({ operation: body.operation, expectedRef: body.expectedRef,
        environment: body.environment, sql: body.sql, table: body.table, limit: body.limit, offset: body.offset,
        minutes: body.minutes, source: body.source, level: body.level })
      const identity = requireReadTarget(state.record, state.linkedRef, options)
      const secrets = [body.deviceSecret]
      const provider = supabaseInspectionProvider(async () => {
        const freshAuth = await authenticateDeviceSecret(supabaseCheckpointDeviceStore(client), body.deviceSecret)
        if (!freshAuth.ok || freshAuth.device.ownerUserId !== ownerId) throw new InspectionError('Dispositivo não autorizado.', 401)
        const project = await getProject(ownerId, body.projectId)
        const environment = await readEnvironment(client, project.id)
        requireReadTarget(environment, project.supabase_project_ref, options)
        const credentials = await getSupabaseCredentials(ownerId, project)
        if (credentials.projectRef !== identity.projectRef) throw new InspectionError('Vínculo do banco mudou. Consulte db status.', 409)
        secrets.push(credentials.token)
        return credentials
      })
      const data = await runInspection(provider, options, secrets)
      return Response.json({ projectId: body.projectId, projectRef: identity.projectRef, environment: identity.environment,
        readOnly: true, observedAt: new Date().toISOString(), operation: options.operation, untrustedData: true, data,
        limits: { rows: options.limit, offset: options.offset, maxOffset: 10000, responseBytes: 512000, statementTimeoutMs: 8000, providerTimeoutMs: 12000 },
      }, { headers })
    }
    if (!body.expectedRef) return Response.json({ error: 'Ref esperado obrigatório.' }, { status: 400 })
    const management = async (ref: string, suffix: string, method: string, payload: unknown) => {
      // Credencial do dono e do projeto; ref NUNCA é escolhido pelo cliente.
      const project = await getProject(ownerId, body.projectId)
      const credentials = await getSupabaseCredentials(ownerId, project)
      if (credentials.projectRef !== ref) throw new Error('Vínculo do banco mudou. Execute novamente após verificar o ambiente.')
      const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/${suffix}`, {
        method, headers: { Authorization: `Bearer ${credentials.token}`, 'Content-Type': 'application/json' },
        ...(payload ? { body: JSON.stringify(payload) } : {}), signal: AbortSignal.timeout(30_000), redirect: 'error',
      })
      if (!res.ok) throw new Error(`Banco indisponível ou operação recusada (HTTP ${res.status}). Nenhum fallback local foi utilizado.`)
      return res.json() as Promise<unknown>
    }
    const result = await runDatabaseOperation({
      verify,
      query: (ref, sql) => management(ref, 'database/query', 'POST', { query: sql }),
      configureAuth: async (ref) => {
        // Patch mínimo: preserva CAPTCHA, limites, providers e confirmação de e-mail.
        await management(ref, 'config/auth', 'PATCH', { external_anonymous_users_enabled: true })
        const config = await management(ref, 'config/auth', 'GET', null) as { external_anonymous_users_enabled?: boolean }
        if (config.external_anonymous_users_enabled !== true) throw new Error('Anonymous Auth não foi confirmado pelo provedor.')
        const keys = await management(ref, 'api-keys', 'GET', null) as Array<{ name: string; api_key: string }>
        const key = keys.find((entry) => entry.name === 'anon')?.api_key
        if (!key) throw new Error('Chave pública de autenticação indisponível.')
        await waitForAnonymousAuth(async () => {
          const response = await fetch(`https://${ref}.supabase.co/auth/v1/settings`, {
            headers: { apikey: key }, cache: 'no-store', signal: AbortSignal.timeout(3000),
          })
          if (!response.ok) return false
          const settings = await response.json() as { external?: { anonymous_users?: boolean }; disable_signup?: boolean }
          return settings.external?.anonymous_users === true && settings.disable_signup === false
        })
      },
    }, body.expectedRef, body.operation, body.migrations)
    return Response.json(result)
  } catch (error) {
    if (isJobsRequest(body)) return Response.json({ error: error instanceof JobsError ? error.message : 'Operação de jobs não autorizada ou vínculo/ambiente alterado. Consulte db status e verifique as permissões do projeto.' }, { status: error instanceof JobsError ? error.status : 409, headers })
    if ('environment' in body) return Response.json({ error: error instanceof InspectionError || error instanceof UnsafeSqlError ? error.message : 'Leitura não autorizada ou vínculo/ambiente alterado. Consulte db status e verifique as permissões do projeto.' }, { status: error instanceof InspectionError ? error.status : 409, headers })
    return Response.json({ error: error instanceof Error ? error.message : 'Falha ao preparar o banco.' }, { status: 409 })
  }
}
