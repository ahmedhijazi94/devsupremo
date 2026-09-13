import { describe, expect, it, vi } from 'vitest'
import { authOptionsSchema, authRequestSchema, isAuthRead } from './options'
import { configView, requireAuthTarget, runAuthAdmin, type AuthAdminProvider } from './service'

const ref = 'dev-ref'
const projectId = '11111111-1111-4111-8111-111111111111'
const userId = '22222222-2222-4222-8222-222222222222'
const record = { project_ref: ref, source: 'supremo_provisioned', environment: 'development' }
const config = { mailer_autoconfirm: false, disable_signup: false, external_anonymous_users_enabled: false, site_url: 'https://app.test', smtp_pass: 'do-not-return' }
const provider = (): AuthAdminProvider & { management: ReturnType<typeof vi.fn>; user: ReturnType<typeof vi.fn> } => ({ management: vi.fn(), user: vi.fn() })

describe('owner-scoped auth administration', () => {
  it('reads unknown linked environments but never silently writes or changes target', () => {
    expect(requireAuthTarget(null, ref, { expectedRef: ref, environment: 'unknown', operation: 'auth-count' }).environment).toBe('unknown')
    for (const options of [
      { expectedRef: 'other', environment: 'development', operation: 'auth-count' },
      { expectedRef: ref, environment: 'production', operation: 'auth-configure' },
      { expectedRef: ref, environment: 'unknown', operation: 'auth-configure' },
    ]) expect(() => requireAuthTarget(record, ref, options)).toThrow(/ambiente/)
    expect(() => requireAuthTarget(null, ref, { expectedRef: ref, environment: 'unknown', operation: 'auth-delete' })).toThrow()
    expect(requireAuthTarget({ ...record, environment: 'production' }, ref, { expectedRef: ref, environment: 'production', operation: 'auth-configure' }).environment).toBe('production')
    expect(isAuthRead('auth-users')).toBe(true)
    expect(isAuthRead('auth-update')).toBe(false)
  })
  it('requires explicit mutation environment and rejects arbitrary SQL, secrets, role and extra fields', () => {
    for (const input of [
      { operation: 'auth-configure', config: { emailConfirmation: false } },
      { operation: 'auth-configure', environment: 'development', config: {} },
      { operation: 'auth-configure', environment: 'development', config: { smtp_pass: 'secret' } },
      { operation: 'auth-count', sql: 'select * from auth.users' },
      { operation: 'auth-users', limit: 201 },
      { operation: 'auth-update', environment: 'development', userId, user: { role: 'admin' } },
      { operation: 'auth-delete', environment: 'development', userId: '../users' },
      { operation: 'auth-create', environment: 'development', email: 'invalid' },
      { operation: 'auth-create', environment: 'development', email: 'a@example.test', password: 'secret' },
      { operation: 'auth-configure', environment: 'development', config: { siteUrl: 'https://user:password@host.test' } },
    ]) expect(authOptionsSchema.safeParse(input).success).toBe(false)
    expect(authRequestSchema.safeParse({ deviceSecret: 'device-secret-fixture', projectId, expectedRef: ref, environment: 'development', operation: 'auth-count' }).success).toBe(true)
    expect(authRequestSchema.safeParse({ deviceSecret: 'device-secret-fixture', projectId, expectedRef: ref, environment: 'development', operation: 'auth-count', sql: 'SELECT 1' }).success).toBe(false)
  })
  it('counts the real auth table without exposing its contents or accepting a caller query', async () => {
    const p = provider(); p.management.mockResolvedValue([{ count: '12' }])
    expect(await runAuthAdmin(p, { operation: 'auth-count' })).toEqual({ users: 12 })
    expect(p.management).toHaveBeenCalledWith('database/query/read-only', 'POST', { query: 'SELECT count(*) AS count FROM auth.users' })
    expect(p.user).not.toHaveBeenCalled()
  })
  it('returns a bounded user projection and explicit pagination', async () => {
    const p = provider(); p.management.mockResolvedValue([{ id: userId, email: 'person@example.test', encrypted_password: 'secret', app_metadata: { role: 'admin' } }])
    expect(await runAuthAdmin(p, { operation: 'auth-users', limit: 1, offset: 2 })).toEqual({ users: [{ id: userId, email: 'person@example.test' }], limit: 1, offset: 2, mayHaveMore: true })
    expect(p.management.mock.calls[0]?.[2].query).toContain('LIMIT 1 OFFSET 2')
  })
  it('exposes only selected non-secret configuration', async () => {
    const p = provider(); p.management.mockResolvedValue(config)
    expect(await runAuthAdmin(p, { operation: 'auth-config' })).toEqual({ emailConfirmation: true, signupsEnabled: true, anonymousSignIns: false, siteUrl: 'https://app.test' })
    expect(configView({ mailer_autoconfirm: true, disable_signup: true })).toEqual({ emailConfirmation: false, signupsEnabled: false })
  })
  it('changes only email confirmation and verifies the provider result', async () => {
    const p = provider(); p.management.mockResolvedValueOnce(config).mockResolvedValueOnce({}).mockResolvedValueOnce({ ...config, mailer_autoconfirm: true })
    const result = await runAuthAdmin(p, { operation: 'auth-configure', environment: 'development', config: { emailConfirmation: false } })
    expect(p.management.mock.calls[1]).toEqual(['config/auth', 'PATCH', { mailer_autoconfirm: true }])
    expect(result).toMatchObject({ before: { emailConfirmation: true }, after: { emailConfirmation: false }, verified: true })
    expect(JSON.stringify(result)).not.toContain('do-not-return')
  })
  it('maps other requested settings and refuses to claim an unconfirmed change', async () => {
    const p = provider(); p.management.mockResolvedValue(config)
    await expect(runAuthAdmin(p, { operation: 'auth-configure', environment: 'production', config: { signupsEnabled: false, anonymousSignIns: true, siteUrl: 'https://new.test' } })).rejects.toThrow(/não confirma/)
    expect(p.management.mock.calls[1]).toEqual(['config/auth', 'PATCH', { disable_signup: true, external_anonymous_users_enabled: true, site_url: 'https://new.test' }])
  })
  it('creates without sending a message and updates only the requested user fields', async () => {
    const p = provider(); p.user.mockResolvedValue({ id: userId, email: 'a@example.test', recovery_token: 'secret' })
    expect(await runAuthAdmin(p, { operation: 'auth-create', environment: 'development', email: 'a@example.test', emailConfirmed: false })).toEqual({ user: { id: userId, email: 'a@example.test' } })
    expect(p.user).toHaveBeenLastCalledWith('POST', null, { email: 'a@example.test', email_confirm: false })
    await runAuthAdmin(p, { operation: 'auth-update', environment: 'development', userId, user: { email: 'b@example.test', emailConfirmed: true, banHours: 24 } })
    expect(p.user).toHaveBeenLastCalledWith('PUT', userId, { email: 'b@example.test', email_confirm: true, ban_duration: '24h' })
    await runAuthAdmin(p, { operation: 'auth-update', environment: 'development', userId, user: { banHours: 0 } })
    expect(p.user).toHaveBeenLastCalledWith('PUT', userId, { ban_duration: 'none' })
    p.user.mockResolvedValue({ id: projectId })
    await expect(runAuthAdmin(p, { operation: 'auth-update', environment: 'development', userId, user: { banHours: 0 } })).rejects.toThrow(/outro usuário/)
  })
  it('deletes only an explicit user ID and propagates provider failure', async () => {
    const p = provider(); p.user.mockResolvedValue({})
    expect(await runAuthAdmin(p, { operation: 'auth-delete', environment: 'development', userId })).toEqual({ userId, deleted: true })
    expect(p.user).toHaveBeenCalledWith('DELETE', userId)
    p.user.mockRejectedValue(new Error('provider refused'))
    await expect(runAuthAdmin(p, { operation: 'auth-delete', environment: 'development', userId })).rejects.toThrow('provider refused')
  })
})
