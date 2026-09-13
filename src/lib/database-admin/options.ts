import { z } from 'zod'

export const authOperationSchema = z.enum(['auth-count', 'auth-users', 'auth-config', 'auth-configure', 'auth-create', 'auth-update', 'auth-delete'])
export type AuthOperation = z.infer<typeof authOperationSchema>
export const isAuthRead = (operation: string): boolean => ['auth-count', 'auth-users', 'auth-config'].includes(operation)
const environment = z.enum(['development', 'production', 'unknown'])
const target = { environment: environment.optional() }
const nonempty = (value: object): boolean => Object.keys(value).length > 0
const authUrl = z.url().max(2000).refine(value => {
  const url = new URL(value)
  return !url.username && !url.password && !url.hash && !url.search &&
    (url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
}, 'URL de autenticação inválida.')
export const authConfigPatchSchema = z.object({
  emailConfirmation: z.boolean().optional(), signupsEnabled: z.boolean().optional(),
  anonymousSignIns: z.boolean().optional(), siteUrl: authUrl.optional(),
}).strict().refine(nonempty, 'Informe pelo menos uma configuração.')
export const authUserPatchSchema = z.object({
  email: z.email().max(320).optional(), emailConfirmed: z.literal(true).optional(),
  banHours: z.number().int().min(0).max(876000).optional(),
}).strict().refine(nonempty, 'Informe pelo menos uma alteração do usuário.')
const mutationTarget = { environment: z.enum(['development', 'production']) }
export const authOptionsSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('auth-count'), ...target }).strict(),
  z.object({ operation: z.literal('auth-config'), ...target }).strict(),
  z.object({ operation: z.literal('auth-users'), ...target, limit: z.number().int().min(1).max(200).default(50), offset: z.number().int().min(0).max(10000).default(0) }).strict(),
  z.object({ operation: z.literal('auth-configure'), ...mutationTarget, config: authConfigPatchSchema }).strict(),
  // Creation never sends email and accepts no password or credential through the agent queue.
  z.object({ operation: z.literal('auth-create'), ...mutationTarget, email: z.email().max(320), emailConfirmed: z.boolean().default(false) }).strict(),
  z.object({ operation: z.literal('auth-update'), ...mutationTarget, userId: z.string().uuid(), user: authUserPatchSchema }).strict(),
  z.object({ operation: z.literal('auth-delete'), ...mutationTarget, userId: z.string().uuid() }).strict(),
])
export type AuthOptions = z.infer<typeof authOptionsSchema>
const requests = authOptionsSchema.options.map(schema => schema.extend({
  deviceSecret: z.string().min(10).max(256), projectId: z.string().uuid(),
  expectedRef: z.string().regex(/^[a-z0-9_-]+$/).max(64), environment,
}))
export const authRequestSchema = z.discriminatedUnion('operation', [requests[0]!, ...requests.slice(1)])
export type AuthRequest = z.infer<typeof authRequestSchema>
