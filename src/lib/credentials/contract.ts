import { z } from 'zod'
import { secretEnvironmentSchema, secretNameSchema } from '@/lib/secret-requests/contract'

export const credentialNameSchema = secretNameSchema.refine((name) => !name.startsWith('AUTH_USER_PASSWORD_'))
export const projectCredentialSchema = z.object({
  id: z.string().uuid(), name: credentialNameSchema, environment: secretEnvironmentSchema,
  createdAt: z.string().datetime({ offset: true }), updatedAt: z.string().datetime({ offset: true }),
})
export const revokeCredentialSchema = z.object({ projectId: z.string().uuid(), credentialId: z.string().uuid() }).strict()
export type ProjectCredentialView = z.infer<typeof projectCredentialSchema>

/** Explicit DTO: database fields and encrypted values never cross the server boundary. */
export function credentialView(input: ProjectCredentialView): ProjectCredentialView {
  return projectCredentialSchema.parse(input)
}
