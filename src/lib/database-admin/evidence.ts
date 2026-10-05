import type { AuthOptions } from './options'
import type { OperationCapability } from '../backend-operations/contract'

export function authMutationCapability(options: AuthOptions): OperationCapability {
  return options.operation === 'auth-invite' ? 'auth.invite' : options.operation === 'auth-role-set' ? 'auth.roles' : options.operation === 'auth-sessions-revoke' ? 'auth.sessions' : options.operation === 'auth-configure' ? 'auth.configure' : 'auth.users'
}
export function authMutationEffects(options: AuthOptions) {
  return { rows: 1, resource: options.operation === 'auth-invite' ? `auth.invite:${options.email.toLowerCase()}` : 'userId' in options ? `auth.users:${options.userId}` : options.operation === 'auth-configure' ? 'auth.config' : 'auth.users' }
}
export function verifiedAuthEvidence(result: Record<string, unknown>): boolean {
  return Boolean(result.data && typeof result.data === 'object' && 'verified' in result.data && result.data.verified === true)
}
