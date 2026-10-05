import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getProject, getSupabaseCredentials } from '../projects/repository'
import { readEnvironment } from '../database-environment/store'
import { requireDevelopment } from '../database-environment/policy'
import { authorizeProjectOperation } from '../backend-operations/server'
import { boundedJson } from '../database-inspection/provider'
import {
  MutationError,
  type MutationOptions,
  type MutationCapability,
} from './contract'
import { runDataMutation, type MutationScope } from './service'

export interface MutationAuthority {
  client: SupabaseClient
  ownerId: string
  projectId: string
  expectedRef: string
  deviceId?: string
  ownerSession?: true
  verifyIdentity(): Promise<string>
}
export async function runAuthorizedMutation(
  authority: MutationAuthority,
  options: MutationOptions,
) {
  let active:
    | {
        capability: MutationCapability
        effects: { rows: number; resource: string }
      }
    | undefined
  const authorize = async (
    capability: MutationCapability,
    effects: { rows: number; resource: string },
  ): Promise<MutationScope> => {
    if ((await authority.verifyIdentity()) !== authority.ownerId)
      throw new MutationError('Identidade não autorizada.', 401)
    const project = await getProject(authority.ownerId, authority.projectId)
    requireDevelopment(
      await readEnvironment(authority.client, project.id),
      project.supabase_project_ref,
      authority.expectedRef,
    )
    if (!project.supabase_account_id)
      throw new MutationError('Conta do banco indisponível.')
    const policy = await authorizeProjectOperation(
      { ...authority, environment: 'development' },
      options.operation === 'data-plan' ? 'data.read' : capability,
      effects,
    )
    active = { capability, effects }
    return {
      ownerId: authority.ownerId,
      projectId: project.id,
      accountId: project.supabase_account_id,
      projectRef: authority.expectedRef,
      environment: 'development',
      ...policy,
    }
  }
  const verify = async () => {
    if (!active)
      throw new MutationError('Autorização de operação ausente.', 403)
    return authorize(active.capability, active.effects)
  }
  return runDataMutation(
    {
      authorize,
      provider: {
        async query(sql, readOnly) {
          const before = await verify(),
            project = await getProject(authority.ownerId, authority.projectId)
          const credentials = await getSupabaseCredentials(
            authority.ownerId,
            project,
          )
          const after = await verify()
          if (
            credentials.projectRef !== authority.expectedRef ||
            JSON.stringify(before) !== JSON.stringify(after)
          )
            throw new MutationError('Destino mudou durante a autorização.')
          let response: Response
          try {
            response = await fetch(
              `https://api.supabase.com/v1/projects/${authority.expectedRef}/database/query`,
              {
                method: 'POST',
                headers: {
                  Authorization: `Bearer ${credentials.token}`,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  query: readOnly
                    ? `BEGIN READ ONLY; SET LOCAL statement_timeout='8s'; ${sql}; COMMIT;`
                    : sql,
                }),
                redirect: 'error',
                cache: 'no-store',
                signal: AbortSignal.timeout(20000),
              },
            )
          } catch {
            throw new MutationError(
              'Resposta do banco não confirmada; não repita a aplicação.',
              504,
            )
          }
          if (!response.ok) {
            await response.body?.cancel()
            throw new MutationError(
              `Banco recusou a operação (HTTP ${response.status}); resultado não confirmado.`,
              response.status === 429 ? 429 : 409,
            )
          }
          try {
            return await boundedJson(response, 400000)
          } catch {
            throw new MutationError(
              'Resposta do banco inválida; resultado não confirmado.',
              502,
            )
          }
        },
      },
      audit: async (event) => {
        await verify()
        const result = await authority.client
          .from('audit_logs')
          .insert({
            ...(event.event === 'claimed' ? { id: event.planId } : {}),
            user_id: authority.ownerId,
            action: `data-mutation.${event.event}`,
            resource_type: 'project',
            resource_id: authority.projectId,
            metadata: { ...event.metadata, planId: event.planId },
            ip_address: null,
          })
        if (result.error?.code === '23505' && event.event === 'claimed')
          throw new MutationError(
            'Plano já utilizado; a operação não será repetida.',
          )
        if (result.error)
          throw new MutationError('Não foi possível registrar a operação.', 503)
      },
    },
    options,
  )
}
