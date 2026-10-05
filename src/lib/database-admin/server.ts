import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getProject, getSupabaseCredentials } from '../projects/repository'
import { readEnvironment } from '../database-environment/store'
import { authorizeProjectOperation } from '../backend-operations/server'
import {
  InspectionError,
  redactInspection,
} from '../database-inspection/provider'
import { authOptionsSchema, isAuthRead, type AuthOptions } from './options'
import { requireAuthTarget, runAuthAdmin } from './service'
import { supabaseAuthAdminProvider } from './provider'
import { assertSamePolicy } from '../backend-operations/policy'
import { authMutationCapability, authMutationEffects } from './evidence'

export interface AuthAuthority {
  client: SupabaseClient
  ownerId: string
  projectId: string
  expectedRef: string
  deviceId?: string
  ownerSession?: true
  verifyIdentity(): Promise<string>
}
/** Shared owner/session/device boundary for both the panel and the agent. */
export async function runAuthorizedAuthOperation(
  authority: AuthAuthority,
  raw: AuthOptions,
) {
  const options = authOptionsSchema.parse(raw),
    secrets: string[] = []
  const capability = isAuthRead(options.operation) ? 'auth.read' as const : authMutationCapability(options), effects = { ...authMutationEffects(options), rows: options.operation === 'auth-users' ? options.limit : 1 }
  let policy: { policyId: string; revision: string } | undefined
  const authorize = async () => {
    if ((await authority.verifyIdentity()) !== authority.ownerId)
      throw new InspectionError('Identidade não autorizada.', 401)
    const project = await getProject(authority.ownerId, authority.projectId)
    const target = requireAuthTarget(
      await readEnvironment(authority.client, project.id),
      project.supabase_project_ref,
      {
        expectedRef: authority.expectedRef,
        environment: options.environment ?? 'unknown',
        operation: options.operation,
      },
    )
    if (!isAuthRead(options.operation) || !authority.ownerSession) {
      if (
        target.environment !== 'development' &&
        target.environment !== 'production'
      )
        throw new InspectionError('Ambiente não confirmado.', 409)
      const current = await authorizeProjectOperation(
        { ...authority, environment: target.environment },
        capability,
        effects,
      )
      if (policy) assertSamePolicy(policy, current)
      else policy = current
      // Role changes also revoke sessions and select exact application roles.
      // Recheck every grant at each provider boundary, including after token
      // refresh; a one-time grant can be revoked without changing the policy.
      if (options.operation === 'auth-role-set') {
        const secondary = await authorizeProjectOperation({ ...authority, environment: target.environment }, 'auth.sessions', effects)
        assertSamePolicy(current, secondary)
        for (const role of options.roles.length ? options.roles : ['remove']) {
          const selected = await authorizeProjectOperation({ ...authority, environment: target.environment }, 'auth.roles', { rows: 1, resource: `role:${role}` })
          assertSamePolicy(current, selected)
        }
      }
    }
    return { project, target }
  }
  const initial = await authorize()
  const provider = supabaseAuthAdminProvider(async () => {
    const current = await authorize()
    if (
      current.project.supabase_account_id !==
      initial.project.supabase_account_id
    )
      throw new InspectionError('Conta do banco mudou.', 409)
    const credentials = await getSupabaseCredentials(
      authority.ownerId,
      current.project,
    )
    const after = await authorize()
    if (
      credentials.projectRef !== authority.expectedRef ||
      after.project.supabase_account_id !== initial.project.supabase_account_id
    )
      throw new InspectionError('Vínculo do banco mudou.', 409)
    return credentials
  }, secrets)
  const result = await runAuthAdmin(provider, options, {
    authorize: async (capability, effects) => {
      const { target } = await authorize()
      if (
        target.environment !== 'development' &&
        target.environment !== 'production'
      )
        throw new InspectionError('Ambiente não confirmado.', 409)
      const current = await authorizeProjectOperation(
        { ...authority, environment: target.environment },
        capability,
        effects,
      )
      if (policy) assertSamePolicy(policy, current)
      return current
    },
  })
  const final = await authorize()
  if (final.project.supabase_account_id !== initial.project.supabase_account_id)
    throw new InspectionError('Conta do banco mudou durante a resposta.', 409)
  const evidence = redactInspection(result, secrets)
  return {
    projectId: authority.projectId,
    projectRef: initial.target.projectRef,
    environment: initial.target.environment,
    operation: options.operation,
    readOnly: isAuthRead(options.operation),
    observedAt: new Date().toISOString(),
    untrustedData: true,
    data: evidence.value,
    redacted: evidence.redacted,
    truncated: evidence.truncated,
  }
}
