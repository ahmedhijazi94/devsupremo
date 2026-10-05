import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AuthAdminProvider } from '@/lib/database-admin/service'
import { applySecretConfiguration } from './configuration'
import { safeSecretError, SecretRequestError, type SecretConfiguration } from './policy'

const userId = '44444444-4444-4444-8444-444444444444'
const smtp: SecretConfiguration = { kind: 'supabase-smtp', provider: 'resend', senderEmail: 'account@example.test', senderName: 'Example' }
const password: SecretConfiguration = { kind: 'supabase-user-password', userId }
const google: SecretConfiguration = { kind: 'supabase-auth-provider', provider: 'google', clientId: 'public-client.apps.googleusercontent.com' }
const github: SecretConfiguration = { kind: 'supabase-auth-provider', provider: 'github', clientId: 'Ov23li_public-client' }
const desired = { smtp_host: 'smtp.resend.com', smtp_port: '465', smtp_user: 'resend', smtp_admin_email: smtp.senderEmail, smtp_sender_name: smtp.senderName }
function provider() {
  return { management: vi.fn<AuthAdminProvider['management']>(), user: vi.fn<AuthAdminProvider['user']>() }
}
afterEach(() => vi.restoreAllMocks())

describe('secure setup operations', () => {
  it.each([google, github])('configures $provider and confirms only enabled state and client ID', async configuration => {
    const p = provider()
    const metadata = { [`external_${configuration.provider}_enabled`]: true, [`external_${configuration.provider}_client_id`]: configuration.clientId }
    p.management.mockResolvedValueOnce({ secret: 'private-value' }).mockResolvedValueOnce({ ...metadata, secret: 'private-value' })
    expect(await applySecretConfiguration(p, configuration, 'private-value')).toBeUndefined()
    expect(p.management.mock.calls).toEqual([
      ['config/auth', 'PATCH', { ...metadata, [`external_${configuration.provider}_secret`]: 'private-value' }],
      ['config/auth', 'GET'],
    ])
    expect(p.user).not.toHaveBeenCalled()
  })
  it.each([{}, { external_google_enabled: false, external_google_client_id: google.clientId },
    { external_google_enabled: true, external_google_client_id: 'another-client' },
    { external_github_enabled: true, external_github_client_id: google.clientId },
    { external_google_enabled: 'true', external_google_client_id: google.clientId }])('does not confirm missing or mismatched OAuth metadata', async response => {
    const p = provider(); p.management.mockResolvedValueOnce({}).mockResolvedValueOnce(response)
    await expect(applySecretConfiguration(p, google, 'private-value')).rejects.toThrow('não confirmou a configuração do provedor de login')
    expect(p.management).toHaveBeenCalledTimes(2)
  })
  it('leaves OAuth configuration unconfirmed when readback fails after PATCH', async () => {
    const p = provider(); p.management.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('private-value'))
    await expect(applySecretConfiguration(p, github, 'private-value')).rejects.toThrow('pedido permanece pendente')
    expect(p.management).toHaveBeenCalledTimes(2)
  })
  it('updates the exact Resend SMTP settings and verifies only metadata without returning the key', async () => {
    const p = provider()
    p.management.mockResolvedValueOnce({ smtp_pass: 'private-value', arbitrary: 'untrusted' }).mockResolvedValueOnce({ ...desired, smtp_pass: 'private-value' })
    expect(await applySecretConfiguration(p, smtp, 'private-value')).toBeUndefined()
    expect(p.management.mock.calls).toEqual([
      ['config/auth', 'PATCH', { ...desired, smtp_pass: 'private-value' }],
      ['config/auth', 'GET'],
    ])
    expect(p.user).not.toHaveBeenCalled()
  })
  it.each(['smtp_host', 'smtp_port', 'smtp_user', 'smtp_admin_email', 'smtp_sender_name'])('refuses a different %s instead of claiming configuration succeeded', async (field) => {
    const p = provider(); p.management.mockResolvedValueOnce({}).mockResolvedValueOnce({ ...desired, [field]: 'unexpected' })
    await expect(applySecretConfiguration(p, smtp, 'private-value')).rejects.toThrow('não confirmou a configuração')
  })
  it('requires a successful provider response for the exact requested user', async () => {
    const p = provider(); p.user.mockResolvedValue({ id: userId, email: 'account@example.test', password: 'private-value' })
    expect(await applySecretConfiguration(p, password, 'private-value')).toBeUndefined()
    expect(p.user).toHaveBeenCalledExactlyOnceWith('PUT', userId, { password: 'private-value' })
    expect(p.management).not.toHaveBeenCalled()
    for (const response of [null, {}, { id: '55555555-5555-4555-8555-555555555555' }]) {
      p.user.mockResolvedValue(response)
      await expect(applySecretConfiguration(p, password, 'private-value')).rejects.toThrow('não confirmou a alteração de senha')
    }
  })
  it.each([smtp, password, google, github])('hides upstream bodies and network errors for $kind', async (configuration) => {
    const p = provider(); const error = new Error('private-value oauth-token sensitive-provider-response')
    p.management.mockRejectedValue(error); p.user.mockRejectedValue(error)
    try { await applySecretConfiguration(p, configuration, 'private-value'); expect.fail('Must fail') }
    catch (caught) {
      expect(caught).toBeInstanceOf(SecretRequestError)
      expect(safeSecretError(caught)).not.toMatch(/private-value|oauth-token|sensitive-provider-response/)
    }
  })
  it('preserves a scoped authorization rejection from the resolver', async () => {
    const p = provider(); p.management.mockRejectedValue(new SecretRequestError('O destino mudou.'))
    await expect(applySecretConfiguration(p, smtp, 'private-value')).rejects.toThrow('O destino mudou.')
  })
})
