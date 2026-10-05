import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getProject, getSupabaseCredentials } from '../projects/repository'
import { readEnvironment } from '../database-environment/store'
import { requireDevelopment } from '../database-environment/policy'
import { DataDeleteError, DataDeleteOperationError, deleteOptionsSchema, deleteResponseSchema, type DeleteOptions, type DeleteResponse } from './contract'
import { describeDeletePlan, runDataDelete } from './service'
import { supabaseDeleteProvider } from './provider'
import { authorizeProjectOperation } from '../backend-operations/server'
import { assertSamePolicy } from '../backend-operations/policy'
import { backendOperationStore } from '../backend-operations/store'
import { runTrackedOperation } from '../backend-operations/service'
import { operationReview } from '../backend-operations/approval-context'

export interface DeleteAuthority {
  client: SupabaseClient
  ownerId: string
  projectId: string
  expectedRef: string
  deviceId?: string
  ownerSession?: true
  verifyIdentity(): Promise<string>
}

export async function runAuthorizedDelete(authority: DeleteAuthority, options: DeleteOptions): Promise<DeleteResponse> {
  options = deleteOptionsSchema.parse(options)
  if (options.operation === 'data-delete-apply') {
    const plan = describeDeletePlan(options.planToken)
    const store = backendOperationStore(authority.client, { ...authority, id: plan.planId, capability: 'data.delete', input: { expectedRef: authority.expectedRef, options }, review: operationReview(plan.targets), expiresAt: plan.expiresAt })
    return store.withAuthorizationContext(() => executeAuthorizedDelete(authority, options))
  }
  return executeAuthorizedDelete(authority, options)
}
async function executeAuthorizedDelete(authority: DeleteAuthority, options: DeleteOptions): Promise<DeleteResponse> {
  const plan = options.operation === 'data-delete-apply' ? describeDeletePlan(options.planToken) : null
  const targets = options.operation === 'data-delete-plan' ? options.targets : plan!.targets
  let policy: { policyId: string; revision: string } | undefined
  const authorizePolicy = async () => {
    for (const table of new Set(targets.map(target => target.table))) {
      const current = await authorizeProjectOperation({ ...authority, environment: 'development' }, options.operation === 'data-delete-plan' ? 'data.read' : 'data.delete', { rows: targets.length, resource: `public.${table}` })
      if (policy) assertSamePolicy(policy, current)
      else policy = current
    }
    return policy!
  }
  const authorize = async () => {
    if (await authority.verifyIdentity() !== authority.ownerId) throw new DataDeleteError('Dispositivo não autorizado.', 401)
    const project = await getProject(authority.ownerId, authority.projectId)
    try { requireDevelopment(await readEnvironment(authority.client, project.id), project.supabase_project_ref, authority.expectedRef) }
    catch { throw new DataDeleteError('Exclusão exige development registrado pelo Supremo e vínculo confirmado. Consulte db status.') }
    if (!project.supabase_account_id) throw new DataDeleteError('Conta do banco indisponível.')
    const authorized = await authorizePolicy()
    return { project, scope: { ownerId: authority.ownerId, projectId: project.id, accountId: project.supabase_account_id,
      projectRef: authority.expectedRef, environment: 'development' as const, policyId: authorized.policyId, policyRevision: authorized.revision } }
  }
  const initial = await authorize()
  const verify = async () => {
    const current = await authorize()
    if (current.scope.accountId !== initial.scope.accountId) throw new DataDeleteError('Conta do banco mudou. Prepare outro plano.')
    return current
  }
  const provider = supabaseDeleteProvider(async () => {
    const { project } = await verify()
    const credentials = await getSupabaseCredentials(authority.ownerId, project)
    await verify()
    if (credentials.projectRef !== authority.expectedRef) throw new DataDeleteError('Vínculo do banco mudou. Prepare outro plano.')
    return credentials
  })
  const execute = () => runDataDelete({ provider, authorize: async () => (await verify()).scope, audit: async event => {
    await verify()
    // audit_logs is append-only. Its existing UUID primary key atomically consumes
    // the plan across workers, and is retained even if the provider times out.
    const result = await authority.client.from('audit_logs').insert({
      ...(event.event === 'claimed' ? { id: event.planId } : {}),
      user_id: authority.ownerId, action: `data-delete.${event.event}`, resource_type: 'project', resource_id: authority.projectId,
      metadata: { ...event.metadata, planId: event.planId }, ip_address: null,
    })
    if (result.error?.code === '23505' && event.event === 'claimed')
      throw new DataDeleteError('Este plano já foi utilizado. Consulte os registros antes de preparar outro; a exclusão não será repetida.')
    if (result.error) throw new DataDeleteError('Não foi possível registrar a operação de exclusão. Resultado não confirmado.', 503)
  } }, options)
  if (!plan) return execute()
  const receipt = await runTrackedOperation({ ...backendOperationStore(authority.client, { ...authority, id: plan.planId, capability: 'data.delete', input: { expectedRef: authority.expectedRef, options }, review: operationReview(plan.targets), expiresAt: plan.expiresAt }),
    authorize: authorizePolicy, execute: async () => ({ ...await execute() }),
    verify: async result => Boolean(result.data && typeof result.data === 'object' && 'verified' in result.data && result.data.verified === true),
  })
  if (receipt.state !== 'succeeded' || !receipt.result) throw new DataDeleteOperationError(receipt.id,
    receipt.state === 'failed' || receipt.state === 'cancelled' ? 'failed' : ['queued', 'running', 'verifying'].includes(receipt.state) ? 'running' : 'uncertain')
  return deleteResponseSchema.parse(receipt.result)
}
