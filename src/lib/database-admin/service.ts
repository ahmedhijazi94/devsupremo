import { z } from 'zod'
import { describeEnvironment } from '../database-environment/policy'
import { InspectionError } from '../database-inspection/provider'
import { authOptionsSchema, isAuthRead, type AuthOptions } from './options'

export function requireAuthTarget(record: unknown, linkedRef: string | null, options: { expectedRef: string; environment: string; operation: string }) {
  const state = describeEnvironment(record, linkedRef)
  if (!state.projectRef || state.projectRef !== options.expectedRef || state.environment !== options.environment ||
    (!isAuthRead(options.operation) && state.environment === 'unknown')) throw new InspectionError('Vínculo ou ambiente de autenticação mudou. Consulte db status.', 409)
  return state
}

export interface AuthAdminProvider {
  management(path: 'config/auth' | 'database/query/read-only', method: 'GET' | 'POST' | 'PATCH', body?: object): Promise<unknown>
  user(method: 'GET' | 'POST' | 'PUT' | 'DELETE', userId: string | null, body?: object): Promise<unknown>
  invite?(email: string, redirectTo?: string): Promise<unknown>
  roles?(userId: string, roles: string[]): Promise<unknown>
  revokeSessions?(userId: string): Promise<unknown>
}
export interface AuthAuthorization {
  authorize(capability: 'auth.roles' | 'auth.sessions', effects: { rows: number; resource: string }): Promise<unknown>
}
// Fixed provider templates avoid accepting HTML or credential-bearing configuration
// through the device queue. Tokens are substituted by Supabase, never by Supremo.
const recoveryEmails = {
  code: {
    subject: 'Seu código para redefinir a senha',
    content: '<h2>Redefinir sua senha</h2><p>Use este código para continuar a recuperação da sua conta:</p><p><strong>{{ .Token }}</strong></p><p>Se você não pediu a recuperação, ignore este email.</p>',
  },
  link: {
    subject: 'Redefina sua senha',
    content: '<h2>Redefinir sua senha</h2><p>Abra o link abaixo para escolher uma nova senha:</p><p><a href="{{ .ConfirmationURL }}">Redefinir senha</a></p><p>Se você não pediu a recuperação, ignore este email.</p>',
  },
} as const
const rawConfigSchema = z.object({ mailer_autoconfirm: z.boolean(), disable_signup: z.boolean(),
  external_anonymous_users_enabled: z.boolean().optional(), site_url: z.string().optional(),
  smtp_host: z.string().max(1000).nullable().optional(), smtp_user: z.string().max(1000).nullable().optional(),
  smtp_admin_email: z.string().max(1000).nullable().optional(),
  mailer_subjects_recovery: z.string().max(1000).nullable().optional(),
  mailer_templates_recovery_content: z.string().max(100_000).nullable().optional(),
  hook_send_email_enabled: z.boolean().nullable().optional(),
  uri_allow_list: z.string().max(100_000).nullable().optional(),
})
function recoveryMode(content: string | null): 'code' | 'link' | 'custom' {
  if (content === recoveryEmails.code.content) return 'code'
  if (content === recoveryEmails.link.content) return 'link'
  return 'custom'
}
export function configView(raw: unknown) {
  const config = rawConfigSchema.parse(raw)
  const smtpFields = [config.smtp_host, config.smtp_user, config.smtp_admin_email]
  const smtpKnown = smtpFields.some(value => value !== undefined)
  const smtpConfigured = smtpFields.every(value => Boolean(value?.trim()))
  const hookEnabled = config.hook_send_email_enabled === true
  return { emailConfirmation: !config.mailer_autoconfirm, signupsEnabled: !config.disable_signup,
    ...(config.external_anonymous_users_enabled !== undefined ? { anonymousSignIns: config.external_anonymous_users_enabled } : {}),
    ...(config.site_url !== undefined ? { siteUrl: config.site_url } : {}),
    ...(config.uri_allow_list !== undefined ? { redirectUrls: (config.uri_allow_list ?? '').split(',').filter(Boolean) } : {}),
    ...(smtpKnown ? { smtp: { configured: smtpConfigured } } : {}),
    ...(config.hook_send_email_enabled !== undefined ? { emailDelivery: {
      transport: hookEnabled ? 'auth_hook' : smtpKnown ? smtpConfigured ? 'custom_smtp' : 'supabase_default' : 'unknown',
      recoveryTemplateSource: hookEnabled ? 'auth_hook' : 'supabase', deliveryVerified: false,
    } } : {}),
    ...(hookEnabled || config.mailer_templates_recovery_content !== undefined ? {
      recoveryEmailMode: hookEnabled ? 'custom' : recoveryMode(config.mailer_templates_recovery_content!),
    } : {}),
  }
}
const userViewSchema = z.object({ id: z.string().uuid(), email: z.string().nullable().optional(),
  created_at: z.string().optional(), email_confirmed_at: z.string().nullable().optional(),
  last_sign_in_at: z.string().nullable().optional(), banned_until: z.string().nullable().optional() })

export async function runAuthAdmin(provider: AuthAdminProvider, raw: AuthOptions, authority?: AuthAuthorization): Promise<unknown> {
  const options = authOptionsSchema.parse(raw)
  if (options.operation === 'auth-role-set' || options.operation === 'auth-sessions-revoke') {
    if (!authority) throw new InspectionError('Esta operação exige a política autenticada do proprietário.', 403)
    const resource = `auth.users:${options.userId}`
    await authority.authorize('auth.sessions', { rows: 1, resource })
    if (options.operation === 'auth-role-set') {
      for (const role of options.roles.length ? options.roles : ['remove']) await authority.authorize('auth.roles', { rows: 1, resource: `role:${role}` })
      if (!provider.roles) throw new InspectionError('Executor de papéis indisponível; nenhuma aprovação foi enfileirada.', 503)
      const result = z.object({ userId: z.literal(options.userId), roles: z.array(z.string()), revision: z.string().uuid(), revokedSessions: z.number().int().nonnegative(), remainingSessions: z.literal(0) }).parse(await provider.roles(options.userId, [...options.roles].sort()))
      if (JSON.stringify(result.roles) !== JSON.stringify([...options.roles].sort())) throw new InspectionError('Papéis retornados não correspondem à alteração solicitada.', 502)
      return { ...result, verified: true, manifestVersion: 1, claimsSaved: true, refreshSessionsRevoked: true,
        accessTokensMayRemainValid: true, sessionRefreshRequired: true,
        message: 'Claims de aplicação gravadas e sessões de renovação revogadas. Tokens de acesso já emitidos permanecem válidos até expirarem; o aplicativo precisa conferir a revisão da sessão antes de ações privilegiadas.' }
    }
    if (!provider.revokeSessions) throw new InspectionError('Executor de sessões indisponível.', 503)
    const result = z.object({ userId: z.literal(options.userId), revokedSessions: z.number().int().nonnegative(), remainingSessions: z.literal(0) }).parse(await provider.revokeSessions(options.userId))
    return { ...result, verified: true, refreshSessionsRevoked: true, accessTokensMayRemainValid: true }
  }
  if (options.operation === 'auth-count') {
    const rows = z.array(z.object({ count: z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) })).length(1)
      .parse(await provider.management('database/query/read-only', 'POST', { query: 'SELECT count(*) AS count FROM auth.users' }))
    return { users: rows[0]!.count }
  }
  if (options.operation === 'auth-users') {
    const users = z.array(userViewSchema).max(options.limit).parse(await provider.management('database/query/read-only', 'POST', {
      query: `SELECT id, email, created_at, email_confirmed_at, last_sign_in_at, banned_until FROM auth.users ORDER BY created_at, id LIMIT ${options.limit} OFFSET ${options.offset}`,
    }))
    return { users, limit: options.limit, offset: options.offset, mayHaveMore: users.length === options.limit }
  }
  if (options.operation === 'auth-config') return configView(await provider.management('config/auth', 'GET'))
  if (options.operation === 'auth-invite') {
    if (!provider.invite) throw new InspectionError('Executor de convites indisponível.', 503)
    if (options.redirectTo) {
      const config = rawConfigSchema.parse(await provider.management('config/auth', 'GET'))
      // Only exact, configured URLs are accepted. Wildcard patterns do not
      // authorize an arbitrary agent-selected redirect carrying login tokens.
      const allowed = [config.site_url, ...(config.uri_allow_list ?? '').split(',').map(value => value.trim())]
      if (!allowed.includes(options.redirectTo)) throw new InspectionError('Cadastre a URL exata de retorno em auth configure antes de enviar o convite.', 409)
    }
    const invitationUser = userViewSchema.extend({ invited_at: z.string().datetime({ offset: true }) })
    const accepted = invitationUser.parse(await provider.invite(options.email, options.redirectTo))
    if (accepted.email?.toLowerCase() !== options.email.toLowerCase()) throw new InspectionError('O provedor retornou outro destinatário; convite não confirmado.', 502)
    const observed = invitationUser.parse(await provider.user('GET', accepted.id))
    if (observed.id !== accepted.id || observed.email?.toLowerCase() !== options.email.toLowerCase()
      || observed.invited_at !== accepted.invited_at)
      throw new InspectionError('A leitura final não confirmou o convite. Consulte o usuário antes de repetir.', 409)
    return { user: observed, invitationAccepted: true, userObserved: true, deliveryVerified: false, verified: true }
  }
  if (options.operation === 'auth-configure') {
    const before = configView(await provider.management('config/auth', 'GET'))
    const desired = options.config
    const recovery = desired.recoveryEmailMode ? recoveryEmails[desired.recoveryEmailMode] : undefined
    // A Send Email Hook renders its own email_data.token/token_hash; changing
    // the SMTP template cannot configure (or prove) the hook's recovery mode.
    if (recovery && before.emailDelivery?.transport === 'auth_hook') {
      throw new InspectionError('O Send Email Hook está ativo e renderiza o próprio email. Configure código ou link na função de envio pelo motor; recoveryEmailMode altera somente o template do envio SMTP. Nenhuma configuração foi enviada.', 409)
    }
    await provider.management('config/auth', 'PATCH', {
      ...(desired.emailConfirmation !== undefined ? { mailer_autoconfirm: !desired.emailConfirmation } : {}),
      ...(desired.signupsEnabled !== undefined ? { disable_signup: !desired.signupsEnabled } : {}),
      ...(desired.anonymousSignIns !== undefined ? { external_anonymous_users_enabled: desired.anonymousSignIns } : {}),
      ...(desired.siteUrl !== undefined ? { site_url: desired.siteUrl } : {}),
      ...(desired.redirectUrls !== undefined ? { uri_allow_list: desired.redirectUrls.join(',') } : {}),
      ...(recovery ? { mailer_subjects_recovery: recovery.subject, mailer_templates_recovery_content: recovery.content } : {}),
    })
    const observed = rawConfigSchema.parse(await provider.management('config/auth', 'GET'))
    const after = configView(observed)
    if (Object.entries(desired).some(([key, value]) => JSON.stringify(after[key as keyof typeof after]) !== JSON.stringify(value)) ||
      recovery && observed.mailer_subjects_recovery !== recovery.subject)
      throw new InspectionError('Alteração enviada, mas a configuração retornada pelo Supabase ainda não confirma o resultado. Consulte auth config antes de repetir.', 409)
    return { before, after, verified: true }
  }
  if (options.operation === 'auth-delete') {
    await provider.user('DELETE', options.userId)
    if (await provider.user('GET', options.userId) !== null) throw new InspectionError('Exclusão enviada, mas o provedor ainda retorna a conta. Resultado não confirmado; não repita sem conferir.', 409)
    return { userId: options.userId, deleted: true, verified: true }
  }
  const patch = options.operation === 'auth-create' ? { email: options.email, email_confirm: options.emailConfirmed } : {
    ...(options.user.email !== undefined ? { email: options.user.email } : {}),
    ...(options.user.emailConfirmed !== undefined ? { email_confirm: true } : {}),
    ...(options.user.banHours !== undefined ? { ban_duration: options.user.banHours === 0 ? 'none' : `${options.user.banHours}h` } : {}),
  }
  const user = userViewSchema.parse(await provider.user(options.operation === 'auth-create' ? 'POST' : 'PUT',
    options.operation === 'auth-create' ? null : options.userId, patch))
  if (options.operation === 'auth-update' && user.id !== options.userId) throw new InspectionError('Resposta pertence a outro usuário; resultado não confirmado.')
  const observed = userViewSchema.parse(await provider.user('GET', user.id))
  if (observed.id !== user.id) throw new InspectionError('Leitura final pertence a outro usuário.', 502)
  const desired = options.operation === 'auth-create' ? { email: options.email, emailConfirmed: options.emailConfirmed } : options.user
  const confirmedDate = observed.email_confirmed_at ? Date.parse(observed.email_confirmed_at) : NaN
  const banDate = observed.banned_until ? Date.parse(observed.banned_until) : NaN
  if (desired.email !== undefined && observed.email?.toLowerCase() !== desired.email.toLowerCase()
    || desired.emailConfirmed === true && !Number.isFinite(confirmedDate)
    || desired.emailConfirmed === false && observed.email_confirmed_at !== null
    || 'banHours' in desired && desired.banHours !== undefined && (desired.banHours === 0
      ? observed.banned_until !== null && (!Number.isFinite(banDate) || banDate > Date.now())
      : !Number.isFinite(banDate) || Math.abs(banDate - Date.now() - desired.banHours * 3600000) > 60000))
    throw new InspectionError('Alteração enviada, mas a leitura final não confirmou os campos solicitados. Consulte o usuário antes de repetir.', 409)
  return { user: observed, verified: true }
}
