import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getProject, getSupabaseCredentials } from '../projects/repository'
import { readEnvironment } from '../database-environment/store'
import { authorizeBackend } from '../project-backend/authorization'
import { OperationError } from '../backend-operations/contract'
import { authorizeProjectOperation } from '../backend-operations/server'
import { backendOperationStore } from '../backend-operations/store'
import { runTrackedOperation } from '../backend-operations/service'
import { storageOptionsSchema, type StorageOptions } from './contract'
import { storageCapability, runStorage } from './service'
import { supabaseStorageProvider } from './provider'
import { assertSamePolicy } from '../backend-operations/policy'

export async function runAuthorizedStorage(scope: { client: SupabaseClient; ownerId: string; projectId: string; deviceId?: string; ownerSession?: true; verifyIdentity(): Promise<string> }, raw: StorageOptions): Promise<Record<string, unknown>> {
  const options = storageOptionsSchema.parse(raw)
  const binding = await authorizeBackend({ ownerId: scope.ownerId, identity: scope.verifyIdentity, project: ownerId => getProject(ownerId, scope.projectId), environment: () => readEnvironment(scope.client, scope.projectId), credentials: getSupabaseCredentials })
  if (binding.target.environment !== options.environment || binding.target.projectRef !== options.expectedRef) throw new OperationError('O armazenamento ou ambiente mudou. Atualize o painel.')
  const capability = storageCapability(options)
  let policy: {policyId:string;revision:string} | undefined
  const authorize = async () => {
    const current=await authorizeProjectOperation({ ...scope, environment: options.environment }, capability, { rows: options.operation === 'storage-remove' ? options.paths.length : 1, ...('bucket' in options ? { resource: options.bucket } : {}) })
    if(policy) assertSamePolicy(policy,current)
    else policy=current
    return current
  }
  const provider = supabaseStorageProvider(async () => { await authorize(); const credentials=await binding.resolve(capability === 'storage.read'); await authorize(); return credentials })
  if (!('operationId' in options)) { await authorize(); const result = await runStorage(provider, options); await binding.verify(); await authorize(); return result }
  const receipt = await runTrackedOperation({ ...backendOperationStore(scope.client, { ...scope, id: options.operationId, capability, input: options }), authorize,
    execute: () => runStorage(provider, options), verify: async result => { await binding.verify(); await authorize(); return result.verified === true } })
  return { receipt }
}
