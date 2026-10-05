import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getProject, getSupabaseCredentials } from '../projects/repository'
import { readEnvironment } from '../database-environment/store'
import { authorizeBackend } from '../project-backend/authorization'
import { authorizeProjectOperation } from '../backend-operations/server'
import { jobsRequestSchema, isReadJobOperation, type JobsRequest } from './policy'
import { supabaseJobsProvider, JobsError } from './provider'
import { requireJobTarget, runJobs } from './service'
import { assertSamePolicy } from '../backend-operations/policy'
import { backendOperationStore } from '../backend-operations/store'
import { runTrackedOperation } from '../backend-operations/service'

export interface JobsAuthority {
  client: SupabaseClient; ownerId: string; projectId: string; expectedRef: string
  deviceId?: string
  ownerSession?: true
  verifyIdentity(): Promise<string>
}

export async function runAuthorizedJobs(scope: JobsAuthority, raw: JobsRequest) {
  const input = jobsRequestSchema.parse(raw)
  if (scope.projectId !== input.projectId || scope.expectedRef !== input.expectedRef) throw new JobsError('Escopo do agendamento mudou.')
  const authority = await authorizeBackend({ ownerId: scope.ownerId, identity: scope.verifyIdentity,
    project: ownerId => getProject(ownerId, scope.projectId), environment: () => readEnvironment(scope.client, scope.projectId),
    credentials: (ownerId, project) => getSupabaseCredentials(ownerId, project),
  })
  requireJobTarget(await readEnvironment(scope.client, scope.projectId), authority.target.projectRef, input)
  let policy: { policyId: string; revision: string } | undefined
  const capability = isReadJobOperation(input.operation) ? 'jobs.read' : input.operation === 'cron-run-now' ? 'jobs.run' : 'jobs.manage'
  const authorize = async () => {
    await authority.verify()
    if (isReadJobOperation(input.operation) && scope.ownerSession) return null
    if (input.environment === 'unknown') throw new JobsError('Confirme o ambiente conectado.')
    const policyScope = { ...scope, environment: input.environment }
    const totalRows = input.manifest?.jobs.reduce((total, job) => total + (job.action.type === 'update' ? job.action.limit : 1), 0) ?? (isReadJobOperation(input.operation) ? input.limit : 1)
    const enforce = async (resource: string) => {
      const current = await authorizeProjectOperation(policyScope, capability, { resource, rows: totalRows })
      if (policy) assertSamePolicy(policy, current)
      else policy = current
    }
    if (input.manifest) {
      for (const job of input.manifest.jobs) await enforce(`jobs:${job.id}`)
    } else await enforce(input.jobId ? `jobs:${input.jobId}` : 'jobs')
    return policy!
  }
  if (isReadJobOperation(input.operation)) await authorize()
  const provider = supabaseJobsProvider(async readOnly => { await authorize(); const credentials=await authority.resolve(readOnly); await authorize(); return credentials })
  provider.authorizeImpact = async (jobId, rows) => {
    if (input.environment === 'unknown' || rows === null) throw new JobsError('Reaplique o manifesto para conferir o limite do job antes de executá-lo.')
    const current = await authorizeProjectOperation({ ...scope, environment: input.environment }, capability, { resource: `jobs:${jobId}`, rows })
    if (policy) assertSamePolicy(policy, current)
  }
  if (isReadJobOperation(input.operation)) return runJobs(provider, input)
  const publicInput = { ...input, deviceSecret: '[server-identity-not-persisted]' }
  const receipt = await runTrackedOperation({ ...backendOperationStore(scope.client, { ...scope, id: input.operationId!, capability, input: publicInput }),
    authorize: async () => (await authorize())!, execute: async () => ({ ...await runJobs(provider, input) }),
    verify: async result => result.applied === true || Boolean(result.receipt && typeof result.receipt === 'object' && 'effect_verified' in result.receipt && result.receipt.effect_verified === true),
  })
  return receipt.state === 'succeeded' && receipt.result ? { ...receipt.result, operationReceipt: receipt } : { operationReceipt: receipt }
}
