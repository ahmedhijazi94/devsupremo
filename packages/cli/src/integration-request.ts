import { z } from 'zod'
import { secretRequestOptionsSchema } from './project-service-request'

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
