import type { AuthOptions } from './options'

export function authMutationCapability(options: AuthOptions): 'auth.roles' | 'auth.sessions' | 'auth.configure' | 'auth.users' {
  return options.operation === 'auth-role-set' ? 'auth.roles' : options.operation === 'auth-sessions-revoke' ? 'auth.sessions' : options.operation === 'auth-configure' ? 'auth.configure' : 'auth.users'
}
export function authMutationEffects(options: AuthOptions) {
  return { rows: 1, resource: 'userId' in options ? `auth.users:${options.userId}` : options.operation === 'auth-configure' ? 'auth.config' : 'auth.users' }
}
export function verifiedAuthEvidence(result: Record<string, unknown>): boolean {
  return Boolean(result.data && typeof result.data === 'object' && 'verified' in result.data && result.data.verified === true)
}
