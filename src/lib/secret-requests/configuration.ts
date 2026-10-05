import { z } from 'zod'
import type { AuthAdminProvider } from '@/lib/database-admin/service'
import { SecretRequestError, type SecretConfiguration } from './policy'

/** Provider responses may contain credentials. Only compare explicitly allowed metadata. */
export async function applySecretConfiguration(provider: AuthAdminProvider, configuration: SecretConfiguration, value: string): Promise<void> {
  try {
    if (configuration.kind === 'supabase-user-password') {
      const result = z.object({ id: z.literal(configuration.userId) }).safeParse(await provider.user('PUT', configuration.userId, { password: value }))
      if (!result.success) throw new Error('User not confirmed')
      return
    }
    if (configuration.kind === 'supabase-auth-provider') {
      const enabled = `external_${configuration.provider}_enabled`
      const clientId = `external_${configuration.provider}_client_id`
      await provider.management('config/auth', 'PATCH', {
        [enabled]: true, [clientId]: configuration.clientId, [`external_${configuration.provider}_secret`]: value,
      })
      const confirmed = z.object({ [enabled]: z.literal(true), [clientId]: z.literal(configuration.clientId) })
        .safeParse(await provider.management('config/auth', 'GET'))
      if (!confirmed.success) throw new Error('Auth provider metadata not confirmed')
      // Saved metadata does not verify the OAuth app, callback registration or a real login.
      return
    }
    const desired = {
      smtp_host: 'smtp.resend.com', smtp_port: '465', smtp_user: 'resend',
      smtp_admin_email: configuration.senderEmail, smtp_sender_name: configuration.senderName,
    }
    await provider.management('config/auth', 'PATCH', { ...desired, smtp_pass: value })
    const confirmed = z.object({
      smtp_host: z.literal(desired.smtp_host), smtp_port: z.literal(desired.smtp_port), smtp_user: z.literal(desired.smtp_user),
      smtp_admin_email: z.literal(desired.smtp_admin_email), smtp_sender_name: z.literal(desired.smtp_sender_name),
    }).safeParse(await provider.management('config/auth', 'GET'))
    if (!confirmed.success) throw new Error('SMTP metadata not confirmed')
    // This confirms saved settings only. It does not certify provider/domain permissions or email delivery.
  } catch (error) {
    if (error instanceof SecretRequestError) throw error
    throw new SecretRequestError(configuration.kind === 'supabase-auth-provider'
      ? 'O Supabase não confirmou a configuração do provedor de login. O pedido permanece pendente; confira a conexão e a configuração antes de tentar novamente.'
      : configuration.kind === 'supabase-user-password'
      ? 'O Supabase não confirmou a alteração de senha. O pedido permanece pendente; confira a conexão e tente novamente.'
      : 'O Supabase não confirmou a configuração de email. O pedido permanece pendente; confira a conexão e tente novamente.')
  }
}
