import { z } from 'zod'

export const authOperationSchema = z.enum(['auth-count', 'auth-users', 'auth-config', 'auth-configure', 'auth-create', 'auth-update', 'auth-delete', 'auth-role-set', 'auth-sessions-revoke'])
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
  recoveryEmailMode: z.enum(['code', 'link']).optional(),
  redirectUrls: z.array(authUrl).max(50).refine(value => new Set(value).size === value.length).optional(),
}).strict().refine(nonempty, 'Informe pelo menos uma configuração.')
export const authUserPatchSchema = z.object({
  email: z.email().max(320).optional(), emailConfirmed: z.literal(true).optional(),
  banHours: z.number().int().min(0).max(876000).optional(),
}).strict().refine(nonempty, 'Informe pelo menos uma alteração do usuário.')
const mutationTarget = { environment: z.enum(['development', 'production']) }
export const applicationRoleSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/)
  .refine(value => !['postgres','service_role','supabase_admin','anon','authenticated','authenticator','superuser','bypassrls','public'].includes(value), 'Papéis internos do banco não são papéis da aplicação.')
export const applicationRolesSchema = z.array(applicationRoleSchema).max(20).refine(value => new Set(value).size === value.length)
export const authOptionsSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('auth-count'), ...target }).strict(),
  z.object({ operation: z.literal('auth-config'), ...target }).strict(),
  z.object({ operation: z.literal('auth-users'), ...target, limit: z.number().int().min(1).max(200).default(50), offset: z.number().int().min(0).max(10000).default(0) }).strict(),
  z.object({ operation: z.literal('auth-configure'), ...mutationTarget, config: authConfigPatchSchema }).strict(),
  // Creation never sends email and accepts no password or credential through the agent queue.
  z.object({ operation: z.literal('auth-create'), ...mutationTarget, email: z.email().max(320), emailConfirmed: z.boolean().default(false) }).strict(),
  z.object({ operation: z.literal('auth-update'), ...mutationTarget, userId: z.string().uuid(), user: authUserPatchSchema }).strict(),
  z.object({ operation: z.literal('auth-delete'), ...mutationTarget, userId: z.string().uuid() }).strict(),
  z.object({ operation: z.literal('auth-role-set'), environment: z.literal('development'), userId: z.string().uuid(), roles: applicationRolesSchema, manifestVersion: z.literal(1) }).strict(),
  z.object({ operation: z.literal('auth-sessions-revoke'), ...mutationTarget, userId: z.string().uuid() }).strict(),
])
export type AuthOptions = z.infer<typeof authOptionsSchema>
const requests = authOptionsSchema.options.map(schema => schema.extend({
  deviceSecret: z.string().min(10).max(256), projectId: z.string().uuid(),
  expectedRef: z.string().regex(/^[a-z0-9_-]+$/).max(64), environment,
  operationId: isAuthRead(schema.shape.operation.value) ? z.uuid().optional() : z.uuid(),
}))
export const authRequestSchema = z.discriminatedUnion('operation', [requests[0]!, ...requests.slice(1)])
export type AuthRequest = z.infer<typeof authRequestSchema>
