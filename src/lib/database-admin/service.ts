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
  user(method: 'POST' | 'PUT' | 'DELETE', userId: string | null, body?: object): Promise<unknown>
}
const rawConfigSchema = z.object({ mailer_autoconfirm: z.boolean(), disable_signup: z.boolean(),
  external_anonymous_users_enabled: z.boolean().optional(), site_url: z.string().optional() })
export function configView(raw: unknown) {
  const config = rawConfigSchema.parse(raw)
  return { emailConfirmation: !config.mailer_autoconfirm, signupsEnabled: !config.disable_signup,
    ...(config.external_anonymous_users_enabled !== undefined ? { anonymousSignIns: config.external_anonymous_users_enabled } : {}),
    ...(config.site_url !== undefined ? { siteUrl: config.site_url } : {}) }
}
const userViewSchema = z.object({ id: z.string().uuid(), email: z.string().nullable().optional(),
  created_at: z.string().optional(), email_confirmed_at: z.string().nullable().optional(),
  last_sign_in_at: z.string().nullable().optional(), banned_until: z.string().nullable().optional() })

export async function runAuthAdmin(provider: AuthAdminProvider, raw: AuthOptions): Promise<unknown> {
  const options = authOptionsSchema.parse(raw)
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
  if (options.operation === 'auth-configure') {
    const before = configView(await provider.management('config/auth', 'GET'))
    const desired = options.config
    await provider.management('config/auth', 'PATCH', {
      ...(desired.emailConfirmation !== undefined ? { mailer_autoconfirm: !desired.emailConfirmation } : {}),
      ...(desired.signupsEnabled !== undefined ? { disable_signup: !desired.signupsEnabled } : {}),
      ...(desired.anonymousSignIns !== undefined ? { external_anonymous_users_enabled: desired.anonymousSignIns } : {}),
      ...(desired.siteUrl !== undefined ? { site_url: desired.siteUrl } : {}),
    })
    const after = configView(await provider.management('config/auth', 'GET'))
    if (Object.entries(desired).some(([key, value]) => after[key as keyof typeof after] !== value))
      throw new InspectionError('Alteração enviada, mas a configuração retornada pelo Supabase ainda não confirma o resultado. Consulte auth config antes de repetir.', 409)
    return { before, after, verified: true }
  }
  if (options.operation === 'auth-delete') {
    await provider.user('DELETE', options.userId)
    return { userId: options.userId, deleted: true }
  }
  const patch = options.operation === 'auth-create' ? { email: options.email, email_confirm: options.emailConfirmed } : {
    ...(options.user.email !== undefined ? { email: options.user.email } : {}),
    ...(options.user.emailConfirmed !== undefined ? { email_confirm: true } : {}),
    ...(options.user.banHours !== undefined ? { ban_duration: options.user.banHours === 0 ? 'none' : `${options.user.banHours}h` } : {}),
  }
  const user = userViewSchema.parse(await provider.user(options.operation === 'auth-create' ? 'POST' : 'PUT',
    options.operation === 'auth-create' ? null : options.userId, patch))
  if (options.operation === 'auth-update' && user.id !== options.userId) throw new InspectionError('Resposta pertence a outro usuário; resultado não confirmado.')
  return { user }
}
