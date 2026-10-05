import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { getProject, getSupabaseCredentials } from '../projects/repository'
import { authorizeBackend } from '../project-backend/authorization'
import { authorizeProjectOperation } from '../backend-operations/server'
import { assertSamePolicy } from '../backend-operations/policy'
import { backendOperationStore } from '../backend-operations/store'
import { runTrackedOperation } from '../backend-operations/service'
import { OperationError } from '../backend-operations/contract'
import { boundedJson } from '../database-inspection/provider'
import { readEnvironment } from './store'
import { databaseRequestSchema, requireDevelopment } from './policy'
import { runDatabaseOperation } from './service'
import { waitForAnonymousAuth } from './auth-readiness'

export interface DatabaseAuthority {
  client: SupabaseClient; ownerId: string; projectId: string; expectedRef: string; deviceId?: string
  ownerSession?: true
  verifyIdentity(): Promise<string>
}
const optionsSchema = z.object({ operation:z.enum(['migrate','anonymous-auth']),expectedRef:databaseRequestSchema.shape.expectedRef.unwrap(),operationId:z.uuid(),migrations:databaseRequestSchema.shape.migrations }).strict()
export async function runAuthorizedDatabaseOperation(scope: DatabaseAuthority, raw: unknown): Promise<Record<string, unknown>> {
  const options = optionsSchema.parse(raw)
  if (options.expectedRef !== scope.expectedRef) throw new OperationError('Destino da operação mudou.')
  const operation = options.operation
  const binding = await authorizeBackend({ ownerId: scope.ownerId, identity: scope.verifyIdentity,
    project: owner => getProject(owner, scope.projectId), environment: () => readEnvironment(scope.client, scope.projectId), credentials: getSupabaseCredentials })
  requireDevelopment(await readEnvironment(scope.client, scope.projectId), binding.target.projectRef, scope.expectedRef)
  const capability = operation === 'migrate' ? 'schema.migrate' : 'auth.configure'
  let policy: { policyId: string; revision: string } | undefined
  const authorize = async () => {
    await binding.verify()
    const current = await authorizeProjectOperation({ ...scope, environment: 'development' }, capability, { resource: operation === 'migrate' ? 'supabase/migrations' : 'auth.config' })
    if (policy) assertSamePolicy(policy, current)
    else policy = current
    return current
  }
  const resolve = async () => { await authorize(); const credentials = await binding.resolve(false); await authorize(); return credentials }
  const management = async (suffix: string, method: string, payload?: unknown): Promise<unknown> => {
    const credentials = await resolve()
    const response = await fetch(`https://api.supabase.com/v1/projects/${credentials.projectRef}/${suffix}`, { method,
      headers: { Authorization: `Bearer ${credentials.token}`, 'Content-Type': 'application/json' },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }), signal: AbortSignal.timeout(30_000), redirect: 'error', cache: 'no-store' })
    if (!response.ok) { await response.body?.cancel(); throw new OperationError(`Banco recusou a operação (HTTP ${response.status}). Resultado não confirmado.`, 502) }
    return boundedJson(response)
  }
  const receipt = await runTrackedOperation({ ...backendOperationStore(scope.client, { ...scope, id: options.operationId!, capability, input: options }), authorize,
    execute: async () => {
      const result = await runDatabaseOperation({
        verify: async () => { const current = await binding.verify(); await authorize(); return { record: await readEnvironment(scope.client, scope.projectId), linkedRef: current.target.projectRef } },
        query: async (ref, sql) => { if (ref !== scope.expectedRef) throw new OperationError('Destino da migration mudou.'); return management('database/query', 'POST', {query:sql}) },
        configureAuth: async ref => {
          if (ref !== scope.expectedRef) throw new OperationError('Destino da autenticação mudou.')
          await management('config/auth', 'PATCH', { external_anonymous_users_enabled: true })
          z.object({ external_anonymous_users_enabled: z.literal(true) }).parse(await management('config/auth','GET'))
          const keys = z.array(z.object({ name:z.string(),api_key:z.string() })).parse(await management('api-keys','GET'))
          const key = keys.find(item => item.name === 'anon')?.api_key
          if (!key) throw new OperationError('Chave pública de autenticação indisponível.')
          await waitForAnonymousAuth(async () => {
            await resolve()
            const response = await fetch(`https://${ref}.supabase.co/auth/v1/settings`, { headers:{apikey:key},cache:'no-store',redirect:'error',signal:AbortSignal.timeout(3000) })
            if (!response.ok) { await response.body?.cancel(); return false }
            const settings = z.object({external:z.object({anonymous_users:z.boolean().optional()}).optional(),disable_signup:z.boolean().optional()}).parse(await boundedJson(response))
            return settings.external?.anonymous_users === true && settings.disable_signup === false
          })
        },
      }, scope.expectedRef, operation, options.migrations)
      if (operation === 'migrate') {
        const history = z.array(z.object({version:z.string(),statements:z.array(z.string()).nullable()})).parse(await management('database/query/read-only','POST',{query:'BEGIN READ ONLY; SELECT version,statements FROM supabase_migrations.schema_migrations ORDER BY version; COMMIT;'}))
        for (const migration of options.migrations ?? []) {
          const version = migration.path.split('/').pop()!.split('_')[0]!
          if (history.find(row => row.version === version)?.statements?.join('\n') !== migration.content) throw new OperationError('O histórico final não confirma a migration enviada.')
        }
      }
      await authorize()
      return { ...result, verified: true }
    }, verify: async result => result.verified === true,
  })
  return receipt.state === 'succeeded' && receipt.result ? { ...receipt.result, receipt } : { receipt }
}
