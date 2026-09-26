import { afterEach, expect, it, vi } from 'vitest'
import { supabaseAuthAdminProvider } from './provider'
import { runAuthAdmin } from './service'
afterEach(() => vi.unstubAllGlobals())
const resolve = async () => ({ projectRef: 'fixture-ref', token: 'server-only-token' })
it('bounds and hides provider errors including permission failures', async () => {
  const fetcher = vi.fn(async () => new Response('upstream secret', { status: 403 })); vi.stubGlobal('fetch', fetcher)
  const p = supabaseAuthAdminProvider(resolve, [])
  await expect(p.management('config/auth', 'GET')).rejects.toThrow(/HTTP 403/)
  fetcher.mockResolvedValue(new Response('upstream secret', { status: 500 }))
  await expect(p.management('config/auth', 'GET')).rejects.not.toThrow(/upstream secret/)
  fetcher.mockResolvedValue(new Response('x'.repeat(512001)))
  await expect(p.management('config/auth', 'GET')).rejects.toThrow(/limite/)
})
it.each([
  { message: 'Updating email templates requires custom SMTP. private-provider-value' },
  { message: ['Email templates cannot be customized with the default email provider. private-provider-value'] },
  { error: 'Configure custom SMTP to edit email templates. private-provider-value' },
])('explains the default-mailer template restriction without leaking provider details', async diagnostic => {
  const config = { mailer_autoconfirm: true, disable_signup: false, hook_send_email_enabled: false,
    smtp_host: null, smtp_user: null, smtp_admin_email: null, smtp_pass: 'private-config-value' }
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json(config)).mockResolvedValueOnce(Response.json(diagnostic, { status: 400 }))
  vi.stubGlobal('fetch', fetcher)
  const result = runAuthAdmin(supabaseAuthAdminProvider(resolve, []), {
    operation: 'auth-configure', environment: 'development', config: { recoveryEmailMode: 'code' },
  })
  await expect(result).rejects.toMatchObject({ status: 409, message: expect.stringContaining('Send Email Hook') })
  await expect(result).rejects.not.toThrow(/private|permissões/)
  expect(fetcher).toHaveBeenCalledTimes(2)
  expect(fetcher.mock.calls[1]?.[1]).toMatchObject({ method: 'PATCH', body: expect.stringContaining('mailer_templates_recovery_content') })
})
it.each([
  JSON.stringify({ message: 'Unrelated invalid configuration. private-value' }),
  JSON.stringify({ message: { private: 'value' } }),
  JSON.stringify({ message: 'custom SMTP template '.repeat(1000) }),
  'not-json private-value',
])('keeps unrecognized or malformed HTTP400 diagnostics bounded and private', async diagnostic => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(diagnostic, { status: 400 })))
  const p = supabaseAuthAdminProvider(resolve, [])
  const result = p.management('config/auth', 'PATCH', { mailer_templates_recovery_content: '<p>{{ .Token }}</p>' })
  await expect(result).rejects.toMatchObject({ status: 502, message: expect.stringContaining('HTTP 400') })
  await expect(result).rejects.not.toThrow(/private|permissões|bloqueou a edição/)
})
it('does not classify unrelated operations as a template restriction', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ message: 'custom SMTP required to edit templates' }, { status: 400 })))
  const p = supabaseAuthAdminProvider(resolve, [])
  await expect(p.management('config/auth', 'PATCH', { disable_signup: false })).rejects.toMatchObject({ status: 502 })
  await expect(p.management('config/auth', 'GET')).rejects.not.toThrow(/bloqueou a edição/)
})
it('handles user creation/deletion and never falls back to a missing or different-project key', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json([{ name: 'service_role', api_key: 'admin-fixture' }]))
    .mockResolvedValueOnce(Response.json({ id: 'created-user' })); vi.stubGlobal('fetch', fetcher)
  const secrets: string[] = []
  const p = supabaseAuthAdminProvider(resolve, secrets)
  expect(await p.user('POST', null, { email: 'a@example.test' })).toEqual({ id: 'created-user' })
  expect(fetcher.mock.calls[1]?.[0]).toBe('https://fixture-ref.supabase.co/auth/v1/admin/users')
  expect(secrets).toContain('admin-fixture')
  fetcher.mockResolvedValueOnce(Response.json([{ name: 'service_role', api_key: 'admin-fixture' }])).mockResolvedValueOnce(new Response(null, { status: 204 }))
  expect(await p.user('DELETE', 'some-id')).toBeNull()
  fetcher.mockResolvedValueOnce(Response.json([]))
  await expect(p.user('DELETE', 'some-id')).rejects.toThrow(/indisponível/)
  const changing = vi.fn().mockResolvedValueOnce(await resolve()).mockResolvedValueOnce(await resolve()).mockResolvedValueOnce({ projectRef: 'foreign', token: 'fixture' })
  fetcher.mockResolvedValueOnce(Response.json([{ name: 'service_role', api_key: 'admin-fixture' }]))
  await expect(supabaseAuthAdminProvider(changing, []).user('DELETE', 'some-id')).rejects.toThrow(/mudou/)
})
