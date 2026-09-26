import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { readEnvironment } from '@/lib/database-environment/store'
import { getProject, getSupabaseCredentials } from '@/lib/projects/repository'
import { functionOptionsSchema, functionResponseSchema, isFunctionRead, type FunctionOptions, type FunctionResponse } from './contract'
import { FunctionError, requireFunctionTarget } from './policy'
import { supabaseFunctionProvider } from './provider'
import { runFunctions } from './service'
import { claimFunctionLease, type FunctionLease } from './store'

const scopeSchema = z.object({ ownerId: z.string().uuid(), projectId: z.string().uuid(), expectedRef: z.string().max(64).regex(/^[a-z0-9_-]+(?![\s\S])/) }).strict()
export interface FunctionAuthorization {
  client: SupabaseClient
  ownerId: string
  projectId: string
  expectedRef: string
  /** Resolve a fresh session/device identity; never return a client-supplied owner. */
  verifyIdentity(): Promise<string>
}

/** Shared by the device API and authenticated panel actions. No caller can skip
 * ownership/environment checks or supply a provider token/ref/URL. */
export async function runAuthorizedFunctions(authority: FunctionAuthorization, raw: FunctionOptions): Promise<FunctionResponse> {
  const { ownerId, projectId, expectedRef } = scopeSchema.parse({ ownerId: authority.ownerId, projectId: authority.projectId, expectedRef: authority.expectedRef })
  const options = functionOptionsSchema.parse(raw)
  let lease: FunctionLease | undefined
  const authorize = async () => {
    if (await authority.verifyIdentity() !== ownerId) throw new FunctionError('Identidade não autorizada.', 401)
    const project = await getProject(ownerId, projectId)
    requireFunctionTarget(await readEnvironment(authority.client, projectId), project.supabase_project_ref, { expectedRef, environment: options.environment })
    return project
  }
  const initial = await authorize()
  const provider = supabaseFunctionProvider(async () => {
    await lease?.assertCurrent()
    const project = await authorize()
    if (project.supabase_account_id !== initial.supabase_account_id) throw new FunctionError('Conta do Supabase mudou durante a operação.')
    const credentials = await getSupabaseCredentials(ownerId, project)
    const current = await authorize()
    if (credentials.projectRef !== expectedRef || current.supabase_account_id !== initial.supabase_account_id) throw new FunctionError('Vínculo do Supabase mudou durante a operação.')
    await lease?.assertCurrent()
    return credentials
  })
  if (!isFunctionRead(options.operation)) {
    const audit = await authority.client.from('audit_logs').insert({ user_id: ownerId, action: `${options.operation}.requested`, resource_type: 'project', resource_id: projectId,
      metadata: { slug: 'slug' in options ? options.slug : null, environment: options.environment, targetRef: expectedRef }, ip_address: null })
    if (audit.error) throw new FunctionError('Não foi possível registrar a operação; nenhuma publicação foi enviada.', 503)
    lease = await claimFunctionLease(authority.client, { ownerId, projectId, projectRef: expectedRef, environment: options.environment })
  }
  const data = await runFunctions(provider, options, { ownerId, projectId, projectRef: expectedRef, environment: options.environment })
  // Recheck the complete binding after the final provider response too. A
  // same-ref account relink must not receive stale metadata or a success receipt.
  const finalProject = await authorize()
  if (finalProject.supabase_account_id !== initial.supabase_account_id) throw new FunctionError('Conta do Supabase mudou durante a operação.')
  // On any failure/timeout retain the short lease, since the provider may still
  // finish an accepted write. A successful operation releases only its own token.
  await lease?.release()
  return functionResponseSchema.parse({ projectId, projectRef: expectedRef, environment: options.environment, operation: options.operation,
    readOnly: isFunctionRead(options.operation), observedAt: new Date().toISOString(), execution: 'server_api', providerDashboardRequired: false, valuesReceived: false, data })
}
