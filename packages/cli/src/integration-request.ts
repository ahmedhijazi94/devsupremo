import { z } from 'zod'
import { credentialIdSchema, secretRequestOptionsSchema, secretResponseSchema, selectRequestedSecrets } from './project-service-request'
import type { DatabaseOperation, DatabaseOptions } from './database-request'

/** Only public setup metadata is accepted here. The value is supplied directly
 * to the authenticated Supremo form, never through argv or the daemon queue. */
export const emailIntegrationOptionsSchema = z.object({
  provider: z.literal('resend'),
  senderEmail: z.string().trim().email().max(254),
  senderName: z.string().trim().min(1).max(100).default('Aplicativo'),
  environment: z.enum(['development', 'production']),
}).strict()

export const authPasswordOptionsSchema = z.object({
  userId: z.string().uuid(),
  environment: z.literal('development'),
}).strict()

export function emailIntegrationRequest(options: unknown): z.infer<typeof secretRequestOptionsSchema> {
  const input = emailIntegrationOptionsSchema.parse(options)
  return secretRequestOptionsSchema.parse({ requests: [{
    name: 'AUTH_SMTP_PASSWORD',
    description: 'Configurar envio de emails de autenticação com Resend no Supabase.',
    target: 'supabase',
    environment: input.environment,
    configuration: { kind: 'supabase-smtp', provider: input.provider, senderEmail: input.senderEmail, senderName: input.senderName },
  }] })
}

export function authPasswordRequest(options: unknown): z.infer<typeof secretRequestOptionsSchema> {
  const input = authPasswordOptionsSchema.parse(options)
  return secretRequestOptionsSchema.parse({ requests: [{
    name: `AUTH_USER_PASSWORD_${input.userId.toUpperCase().replaceAll('-', '_')}`,
    description: 'Definir a senha da conta de desenvolvimento pelo formulário seguro.',
    target: 'supabase',
    environment: input.environment,
    configuration: { kind: 'supabase-user-password', userId: input.userId },
  }] })
}

/** References are validated before creating a request. The daemon/server still
 * enforce project, environment and current request authority on each call. */
export function validateCredentialReuse(input: z.infer<typeof secretRequestOptionsSchema>, credentialId: unknown): string | undefined {
  if (credentialId === undefined) return undefined
  const id = credentialIdSchema.parse(credentialId)
  if (input.requests.length !== 1) throw new Error('Use uma credencial armazenada com exatamente um campo por pedido.')
  if (input.requests[0]!.configuration?.kind === 'supabase-user-password') throw new Error('Senhas de usuários devem ser preenchidas no formulário seguro; não são reutilizadas do cofre.')
  return id
}

export async function requestIntegration(input: z.infer<typeof secretRequestOptionsSchema>, credentialId: unknown,
  execute: (operation: DatabaseOperation, options: DatabaseOptions) => Promise<unknown>): Promise<unknown> {
  const requested = secretRequestOptionsSchema.parse(input)
  const id = validateCredentialReuse(requested, credentialId)
  const result = await execute('secrets-request', requested)
  if (id === undefined) return result
  const parsed = secretResponseSchema.parse(result)
  const selected = selectRequestedSecrets(parsed.requests, requested.requests)[0]!
  if (selected.status !== 'pending') throw new Error('O pedido já foi atendido. Para alterar a configuração, use secrets dismiss e crie um novo pedido; nenhum valor foi substituído.')
  const applied = await execute('secrets-apply', { requestId: selected.id, credentialId: id })
  const confirmed = secretResponseSchema.extend({ projectId: z.literal(parsed.projectId) }).parse(applied)
  const receipt = selectRequestedSecrets(confirmed.requests, requested.requests)[0]!
  if (receipt.id !== selected.id || receipt.status !== 'fulfilled') throw new Error('O servidor não confirmou a aplicação da credencial ao pedido solicitado.')
  return applied
}
