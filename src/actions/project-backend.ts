'use server'

import { requireUser } from '@/lib/auth'
import { createServiceClient } from '@/lib/supabase/admin'
import { getProject, getSupabaseCredentials } from '@/lib/projects/repository'
import { readEnvironment } from '@/lib/database-environment/store'
import { InspectionError, redactInspection, supabaseInspectionProvider } from '@/lib/database-inspection/provider'
import { UnsafeSqlError } from '@/lib/database/sql-guard'
import { supabaseAuthAdminProvider } from '@/lib/database-admin/provider'
import { runAuthAdmin } from '@/lib/database-admin/service'
import { JobsError, supabaseJobsProvider } from '@/lib/database-jobs/provider'
import { runJobs } from '@/lib/database-jobs/service'
import { jobsRequestSchema } from '@/lib/database-jobs/policy'
import { runAuthorizedFunctions } from '@/lib/edge-functions/server'
import { FunctionError } from '@/lib/edge-functions/policy'
import { backendInputSchema, type BackendInput, type BackendResult } from '@/lib/project-backend/contract'
import { authorizeBackend } from '@/lib/project-backend/authorization'
import { runBackend } from '@/lib/project-backend/service'

export async function runProjectBackend(raw: BackendInput): Promise<BackendResult> {
  const parsed = backendInputSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, error: 'Pedido inválido. Confira a operação, os campos e os limites.' }
  const input = parsed.data
  const secrets: string[] = []
  try {
    const { user } = await requireUser()
    const client = createServiceClient()
    const identity = async () => (await requireUser()).user.id
    const authority = await authorizeBackend({ ownerId: user.id, identity,
      project: ownerId => getProject(ownerId, input.projectId), environment: () => readEnvironment(client, input.projectId),
      credentials: async (ownerId, project) => { const credentials = await getSupabaseCredentials(ownerId, project); secrets.push(credentials.token); return credentials },
    })
    const target = authority.target
    const audit = async () => {
      await authority.verify()
      const result = await client.from('audit_logs').insert({ user_id: user.id, action: input.enabled ? 'cron-resume.requested' : 'cron-pause.requested', resource_type: 'project', resource_id: input.projectId,
        metadata: { jobId: input.jobId!, targetRef: target.projectRef, environment: target.environment, source: 'backend_console' }, ip_address: null })
      if (result.error) throw new InspectionError('Não foi possível registrar a alteração. O agendamento não foi alterado.', 503)
    }
    const data = await runBackend({
      inspection: supabaseInspectionProvider(() => authority.resolve()),
      users: (limit, offset) => runAuthAdmin(supabaseAuthAdminProvider(() => authority.resolve(), secrets), { operation: 'auth-users', limit, offset }),
      functions: async (operation, slug) => {
        if (target.environment === 'unknown') throw new InspectionError('Confirme o ambiente conectado antes de consultar funções pelo motor.', 409)
        return runAuthorizedFunctions({ client, ownerId: user.id, projectId: input.projectId, expectedRef: target.projectRef, verifyIdentity: identity },
          operation === 'functions-list' ? { operation, environment: target.environment } : { operation, environment: target.environment, slug: slug! })
      },
      jobs: async (operation, fields) => {
        if (operation === 'cron-pause' || operation === 'cron-resume') await audit()
        return runJobs(supabaseJobsProvider(readOnly => authority.resolve(readOnly)), jobsRequestSchema.parse({
          // Internal typed-service envelope, not device authorization. Session
          // ownership is revalidated by authority.resolve on every provider call.
          deviceSecret: 'owner-session-internal', projectId: input.projectId, operation, expectedRef: target.projectRef, environment: target.environment,
          limit: fields.limit, offset: fields.offset, ...(fields.jobId ? { jobId: fields.jobId } : {}),
        }))
      },
    }, target, input)
    await authority.verify()
    const safe = redactInspection(data, secrets).value as typeof data
    return { ok: true, data: safe, ...target, observedAt: new Date().toISOString() }
  } catch (error) {
    const known = error instanceof InspectionError || error instanceof UnsafeSqlError || error instanceof JobsError || error instanceof FunctionError
    return { ok: false, error: known ? String(redactInspection(error.message, secrets).value) : 'Não foi possível confirmar os dados. Verifique sua sessão, a conexão e as permissões do projeto.' }
  }
}
