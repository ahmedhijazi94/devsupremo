import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { readEnvironment } from '../database-environment/store'
import { describeEnvironment } from '../database-environment/policy'
import { OperationError, policyInputSchema, type OperationCapability, type OperationPolicy } from './contract'
import { enforceOperationPolicy } from './policy'
import { authorizeOneTimeOperation } from './approvals'

export interface OperationAuthority {
  client: SupabaseClient; ownerId: string; projectId: string; environment: 'development' | 'production'
  deviceId?: string
  ownerSession?: true
  verifyIdentity(): Promise<string>
}
const storedPolicySchema = policyInputSchema.safeExtend({ id: z.string().uuid(), ownerId: z.string().uuid(), revision: z.string().uuid() })

export async function readOperationPolicy(client: SupabaseClient, ownerId: string, projectId: string, environment: 'development' | 'production'): Promise<OperationPolicy | null> {
  const { data, error } = await client.from('project_automation_policies').select('*').eq('user_id', ownerId).eq('project_id', projectId).eq('environment', environment).maybeSingle()
  if (error) throw new OperationError('Não foi possível consultar a autorização. Confira se o motor recebeu a migration 028.', 503)
  if (!data) return null
  const parsed = storedPolicySchema.safeParse({ expectedRevision: null, id: data.id, ownerId: data.user_id, projectId: data.project_id, environment: data.environment,
    revision: data.revision, enabled: data.enabled, capabilities: data.capabilities, maxRows: data.max_rows,
    maxOperationsPerHour: data.max_operations_per_hour, resources: data.resources, deviceIds: data.device_ids })
  if (!parsed.success) throw new OperationError('Política inválida. O dono precisa salvá-la novamente.', 409)
  return parsed.data
}

/** Provider adapters must additionally pin their account, ref and target and
 * revalidate these immediately before each effect. No caller-supplied owner. */
export async function authorizeProjectOperation(authority: OperationAuthority, capability: OperationCapability, effects: { rows?: number; resource?: string } = {}): Promise<{ policyId: string; revision: string }> {
  if (await authority.verifyIdentity() !== authority.ownerId) throw new OperationError('Sessão ou dispositivo não autorizado.', 401)
  const { data: project, error } = await authority.client.from('projects').select('id,supabase_project_ref,supabase_account_id').eq('id', authority.projectId).eq('user_id', authority.ownerId).maybeSingle()
  if (error || !project) throw new OperationError('Projeto não autorizado.', 403)
  const environment = describeEnvironment(await readEnvironment(authority.client, authority.projectId), project.supabase_project_ref)
  if (environment.environment !== authority.environment) throw new OperationError('O ambiente conectado mudou ou ainda não foi confirmado.', 409)
  const policy = await readOperationPolicy(authority.client, authority.ownerId, authority.projectId, authority.environment)
  if (await authority.verifyIdentity() !== authority.ownerId) throw new OperationError('Sessão ou dispositivo mudou.', 401)
  if (!policy || policy.capabilities.includes(capability)) return enforceOperationPolicy(policy, authority, capability, effects)
  // Only the missing capability may be supplemented. Every other scope check
  // runs unchanged before preparing or consulting a one-time approval.
  const authorization = enforceOperationPolicy({ ...policy, capabilities: [...policy.capabilities, capability] }, authority, capability, effects)
  await authorizeOneTimeOperation(authority, policy, capability, effects, { projectRef: project.supabase_project_ref ?? '', accountId: project.supabase_account_id ?? null })
  return authorization
}
