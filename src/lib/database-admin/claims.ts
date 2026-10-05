import { z } from 'zod'
import { applicationRolesSchema } from './options'

export const applicationRoleManifestSchema = z
  .object({ version: z.literal(1), roles: applicationRolesSchema })
  .strict()
const roleClaims = z.object({
  roles: applicationRolesSchema,
  roles_revision: z.string().uuid(),
})

/** Supplemental server-side check after cryptographic JWT validation. Claims
 * decide the role; a live server snapshot prevents a revoked/old access token
 * from retaining that role until its expiry. Never pass user_metadata here. */
export function currentApplicationRole(input: {
  verifiedJwt: unknown
  current: {
    userId: string
    sessionId: string
    active: boolean
    appMetadata: unknown
  }
  requiredRole: string
}): boolean {
  const jwt = z
    .object({
      sub: z.string().uuid(),
      session_id: z.string().uuid(),
      app_metadata: z.object({ supremo: roleClaims }),
    })
    .safeParse(input.verifiedJwt)
  const current = z
    .object({ supremo: roleClaims })
    .safeParse(input.current.appMetadata)
  return Boolean(
    jwt.success &&
    current.success &&
    input.current.active &&
    jwt.data.sub === input.current.userId &&
    jwt.data.session_id === input.current.sessionId &&
    jwt.data.app_metadata.supremo.roles_revision ===
      current.data.supremo.roles_revision &&
    jwt.data.app_metadata.supremo.roles.includes(input.requiredRole) &&
    current.data.supremo.roles.includes(input.requiredRole),
  )
}
