import 'server-only'
import { z } from 'zod'
import { authorizeProjectOperation } from '../backend-operations/server'
import { backendOperationStore } from '../backend-operations/store'
import { runTrackedOperation } from '../backend-operations/service'
import { InspectionError } from '../database-inspection/provider'
import { isAuthRead, authOptionsSchema, type AuthOptions } from './options'
import { runAuthorizedAuthOperation, type AuthAuthority } from './server'
import { authMutationCapability, authMutationEffects, verifiedAuthEvidence } from './evidence'

/** One durable ID represents one auth write across the API, UI and retries. */
export async function runTrackedAuthOperation(authority: AuthAuthority, raw: AuthOptions, operationId?: string): Promise<Record<string, unknown>> {
  const options = authOptionsSchema.parse(raw)
  if (isAuthRead(options.operation)) return runAuthorizedAuthOperation(authority, options)
  if (options.environment !== 'development' && options.environment !== 'production') throw new InspectionError('Confirme o ambiente antes de alterar a autenticação.')
  const environment = options.environment, capability = authMutationCapability(options)
  const receipt = await runTrackedOperation({
    ...backendOperationStore(authority.client, { ...authority, id: z.uuid().parse(operationId), capability, input: { expectedRef: authority.expectedRef, options } }),
    authorize: async () => {
      const current = await authorizeProjectOperation({ ...authority, environment }, capability, authMutationEffects(options))
      if (options.operation === 'auth-role-set') {
        await authorizeProjectOperation({ ...authority, environment }, 'auth.sessions', authMutationEffects(options))
        for (const role of options.roles.length ? options.roles : ['remove']) await authorizeProjectOperation({ ...authority, environment }, 'auth.roles', {rows:1,resource:`role:${role}`})
      }
      return current
    },
    execute: () => runAuthorizedAuthOperation(authority, options),
    verify: async result => verifiedAuthEvidence(result),
  })
  return receipt.state === 'succeeded' && receipt.result ? { ...receipt.result, receipt } : {
    operation: options.operation, projectId: authority.projectId, projectRef: authority.expectedRef, environment, receipt,
  }
}
