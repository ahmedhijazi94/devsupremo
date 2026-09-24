import { describe, expect, it, vi } from 'vitest'
import { authPasswordRequest, emailIntegrationRequest, requestIntegration } from './integration-request'
import { isDatabaseReadCommand, parseDatabaseOptions, type DatabaseOperation, type DatabaseOptions } from './database-request'
import { credentialResponse, secretResponse } from './project-service-request'

const USER = 'aabbccdd-1111-4111-8111-123456789abc'
const PROJECT = '11111111-1111-4111-8111-111111111111'
const ISSUER = 'https://supremo.example.invalid'
const SMTP = { provider: 'resend', senderEmail: 'hello@example.invalid', senderName: 'Meu app', environment: 'development' }
const REQUEST = '22222222-2222-4222-8222-222222222222'
const CREDENTIAL = '33333333-3333-4333-8333-333333333333'
const smtpView = { id: REQUEST, ...emailIntegrationRequest(SMTP).requests[0]!, targetRef: 'owned-ref', status: 'pending' as const }

describe('integration setup requests are strictly metadata-only', () => {
  it('requests direct SMTP configuration in the explicit environment with the selected sender', () => {
    expect(emailIntegrationRequest(SMTP)).toEqual({ requests: [{
      name: 'AUTH_SMTP_PASSWORD', description: 'Configurar envio de emails de autenticação com Resend no Supabase.',
      target: 'supabase', environment: 'development', configuration: {
        kind: 'supabase-smtp', provider: 'resend', senderEmail: 'hello@example.invalid', senderName: 'Meu app',
      },
    }] })
    expect(emailIntegrationRequest({ ...SMTP, environment: 'production', senderName: undefined }).requests[0]).toMatchObject({
      environment: 'production', configuration: { senderName: 'Aplicativo' },
    })
  })
  it.each([
    { ...SMTP, environment: undefined }, { ...SMTP, environment: 'preview' }, { ...SMTP, senderEmail: undefined },
    { ...SMTP, senderEmail: 'invalid' }, { ...SMTP, provider: 'unknown' }, { ...SMTP, senderName: 'App\r\nBcc: other' },
    { ...SMTP, password: 'never-accepted' }, { ...SMTP, apiKey: 'never-accepted' }, { ...SMTP, value: 'never-accepted' },
    { ...SMTP, smtpHost: 'attacker.invalid' }, { ...SMTP, userId: USER },
  ])('rejects unsupported or secret-bearing SMTP inputs before queueing', options => {
    expect(() => emailIntegrationRequest(options)).toThrow()
  })
  it('scopes a password field to the exact development account without accepting its value', () => {
    expect(authPasswordRequest({ userId: USER, environment: 'development' })).toEqual({ requests: [{
      name: 'AUTH_USER_PASSWORD_AABBCCDD_1111_4111_8111_123456789ABC',
      description: 'Definir a senha da conta de desenvolvimento pelo formulário seguro.',
      target: 'supabase', environment: 'development', configuration: { kind: 'supabase-user-password', userId: USER },
    }] })
  })
  it.each([
    { userId: USER }, { userId: USER, environment: 'production' }, { userId: 'not-a-uuid', environment: 'development' },
    { userId: USER, environment: 'development', password: 'never-accepted' },
    { userId: USER, environment: 'development', email: 'other@example.invalid' },
    { userId: USER, environment: 'development', config: { emailConfirmation: false } },
  ])('rejects password values, production and unrelated auth changes', options => {
    expect(() => authPasswordRequest(options)).toThrow()
  })
})

describe('setup metadata response never trusts upstream links or secret fields', () => {
  it('returns only known fields and an issuer-pinned form with safe next action', () => {
    const response = secretResponse({ projectId: PROJECT, formUrl: 'https://attacker.invalid', token: 'never-return', requests: [{
      id: '22222222-2222-4222-8222-222222222222', ...emailIntegrationRequest(SMTP).requests[0],
      targetRef: 'owned-ref', status: 'pending', value: 'never-return', password: 'never-return',
    }] }, PROJECT, ISSUER)
    expect(response).toMatchObject({ valuesReceived: false, formUrl: `${ISSUER}/projects/${PROJECT}#secrets`,
      nextAction: { kind: 'open_secure_form', formUrl: `${ISSUER}/projects/${PROJECT}#secrets`, userInput: 'secret_value' },
      requests: [{ configuration: { kind: 'supabase-smtp', senderName: 'Meu app' } }],
    })
    expect(JSON.stringify(response)).not.toMatch(/never-return|attacker/)
  })
  it('does not claim verified delivery when configuration is fulfilled', () => {
    const response = secretResponse({ projectId: PROJECT, requests: [{
      id: '22222222-2222-4222-8222-222222222222', ...authPasswordRequest({ userId: USER, environment: 'development' }).requests[0],
      targetRef: 'owned-ref', status: 'fulfilled',
    }] }, PROJECT, ISSUER)
    expect(response).toMatchObject({ nextAction: { kind: 'continue_integration', configurationOnly: true, deliveryVerified: false } })
  })
  it('returns an API receipt and ignores unrelated pending requests when tracking an applied request', () => {
    const response = secretResponse({ projectId: PROJECT, requests: [
      { ...smtpView, status: 'fulfilled', receipt: { kind: 'fake', password: 'never-return' } },
      { ...smtpView, id: USER, name: 'OTHER_API_KEY', configuration: undefined },
    ] }, PROJECT, ISSUER, [REQUEST])
    expect(response).toMatchObject({ selectedRequestIds: [REQUEST], nextAction: { kind: 'continue_integration', providerDashboardRequired: false },
      requests: [{ receipt: { kind: 'smtp_configured', execution: 'server_api', applied: true, deliveryVerified: false, providerDashboardRequired: false } },
        { receipt: { status: 'pending', applied: false } }] })
    expect(JSON.stringify(response)).not.toMatch(/fake|never-return/)
    expect(() => secretResponse({ projectId: PROJECT, requests: [] }, PROJECT, ISSUER, [REQUEST])).toThrow('não confirma')
    expect(() => secretResponse({ projectId: PROJECT, requests: [smtpView, smtpView] }, PROJECT, ISSUER, [REQUEST])).toThrow('não confirma')
  })
  it('describes the installed environment separately from an end-to-end integration', () => {
    expect(secretResponse({ projectId: PROJECT, requests: [{ ...smtpView, configuration: undefined, status: 'fulfilled' }] }, PROJECT, ISSUER)).toMatchObject({
      requests: [{ receipt: { kind: 'environment_secret_installed', integrationVerified: false } }],
    })
  })
  it('rejects unknown fields inside configuration and responses for another project', () => {
    const entry = { id: '22222222-2222-4222-8222-222222222222', ...emailIntegrationRequest(SMTP).requests[0],
      targetRef: 'owned-ref', status: 'pending', configuration: { kind: 'supabase-smtp', ...SMTP, password: 'never-return' } }
    expect(() => secretResponse({ projectId: PROJECT, requests: [entry] }, PROJECT, ISSUER)).toThrow()
    expect(() => secretResponse({ projectId: USER, requests: [] }, PROJECT, ISSUER)).toThrow()
  })
})

describe('vault references never become credentials in the daemon or output', () => {
  const metadata = { id: CREDENTIAL, name: 'RESEND_API_KEY', environment: 'development',
    createdAt: '2026-09-24T12:00:00Z', updatedAt: '2026-09-24T12:00:00+00:00' }
  it('whitelists metadata and rejects another project or secret-bearing command fields', () => {
    expect(credentialResponse({ projectId: PROJECT, credentials: [{ ...metadata, value: 'never-return', encryptedValue: 'never-return' }], token: 'never-return' }, PROJECT))
      .toEqual({ projectId: PROJECT, credentials: [metadata], valuesReceived: false })
    expect(() => credentialResponse({ projectId: USER, credentials: [metadata] }, PROJECT)).toThrow()
    expect(parseDatabaseOptions('secrets-apply', { requestId: REQUEST, credentialId: CREDENTIAL })).toEqual({ requestId: REQUEST, credentialId: CREDENTIAL })
    expect(parseDatabaseOptions('secrets-credentials', {})).toEqual({})
    expect(parseDatabaseOptions('secrets-revoke-credential', { credentialId: CREDENTIAL })).toEqual({ credentialId: CREDENTIAL })
    for (const operation of ['secrets-credentials', 'secrets-apply', 'secrets-revoke-credential'] as const) {
      expect(() => parseDatabaseOptions(operation, { credentialId: CREDENTIAL, requestId: REQUEST, value: 'never-accepted' })).toThrow()
    }
  })
  it('accepts the full server list bound after older requests were dismissed', () => {
    const credentials = Array.from({ length: 201 }, (_, index) => ({ ...metadata,
      id: `33333333-3333-4333-8333-${index.toString(16).padStart(12, '0')}`, value: 'never-return',
    }))
    const result = credentialResponse({ projectId: PROJECT, credentials }, PROJECT)
    expect(result).toMatchObject({ credentials: credentials.map(({ id, name, environment, createdAt, updatedAt }) => ({ id, name, environment, createdAt, updatedAt })) })
    expect(JSON.stringify(result)).not.toContain('never-return')
    expect(() => credentialResponse({ projectId: PROJECT, credentials: Array.from({ length: 1001 }, () => metadata) }, PROJECT)).toThrow()
  })
  const executor = (requests = [smtpView]) => vi.fn(async (operation: DatabaseOperation, options: DatabaseOptions): Promise<unknown> => ({
    projectId: PROJECT, requests: requests.map(request => operation === 'secrets-apply' && request.id === options.requestId ? { ...request, status: 'fulfilled' } : request),
  }))
  it('creates then applies only the exact request, independently of unrelated list order', async () => {
    const unrelated = { ...smtpView, id: USER, environment: 'production' as const }
    const execute = executor([unrelated, smtpView])
    const input = emailIntegrationRequest(SMTP)
    const result = await requestIntegration(input, CREDENTIAL, execute)
    expect(execute.mock.calls).toEqual([
      ['secrets-request', input], ['secrets-apply', { requestId: REQUEST, credentialId: CREDENTIAL }],
    ])
    expect(result).toMatchObject({ requests: [{ status: 'pending' }, { id: REQUEST, status: 'fulfilled' }] })
  })
  it('does not perform apply when the secure form is needed', async () => {
    const execute = executor()
    await requestIntegration(emailIntegrationRequest(SMTP), undefined, execute)
    expect(execute).toHaveBeenCalledTimes(1)
  })
  it('rejects invalid references, multiple fields and account password reuse before creating requests', async () => {
    const execute = executor()
    await expect(requestIntegration(emailIntegrationRequest(SMTP), 'not-a-reference', execute)).rejects.toThrow()
    await expect(requestIntegration({ requests: [smtpView, { ...smtpView, name: 'OTHER_KEY' }].map(({ name, description, target, environment }) => ({ name, description, target, environment })) }, CREDENTIAL, execute)).rejects.toThrow('exatamente um')
    await expect(requestIntegration(authPasswordRequest({ userId: USER, environment: 'development' }), CREDENTIAL, execute)).rejects.toThrow('não são reutilizadas')
    expect(execute).not.toHaveBeenCalled()
  })
  it.each([
    { requests: [] }, { requests: [smtpView, smtpView] }, { requests: [{ ...smtpView, environment: 'production' }] },
    { requests: [{ ...smtpView, configuration: { ...smtpView.configuration!, senderEmail: 'different@example.invalid' } }] },
  ])('refuses missing/ambiguous/different-destination request lists', async ({ requests }) => {
    const execute = vi.fn().mockResolvedValue({ projectId: PROJECT, requests })
    await expect(requestIntegration(emailIntegrationRequest(SMTP), CREDENTIAL, execute)).rejects.toThrow('não identifica')
    expect(execute).toHaveBeenCalledTimes(1)
  })
  it('requires dismiss/new request for fulfilled configuration instead of silently replacing a secret', async () => {
    const execute = vi.fn().mockResolvedValue({ projectId: PROJECT, requests: [{ ...smtpView, status: 'fulfilled' }] })
    await expect(requestIntegration(emailIntegrationRequest(SMTP), CREDENTIAL, execute)).rejects.toThrow('secrets dismiss')
    expect(execute).toHaveBeenCalledTimes(1)
  })
  it.each([
    { projectId: PROJECT, requests: [smtpView] },
    { projectId: PROJECT, requests: [{ ...smtpView, id: USER, status: 'fulfilled' }] },
    { projectId: USER, requests: [{ ...smtpView, status: 'fulfilled' }] },
  ])('does not report success without an exact server confirmation', async applied => {
    const execute = vi.fn().mockResolvedValueOnce({ projectId: PROJECT, requests: [smtpView] }).mockResolvedValueOnce(applied)
    await expect(requestIntegration(emailIntegrationRequest(SMTP), CREDENTIAL, execute)).rejects.toThrow()
  })
})

describe('secure field requests do not launch app QA or recovery', () => {
  it.each([
    'supremo integrations email --provider resend --sender-email hello@example.invalid --sender-name "Meu app" --environment development',
    'node node_modules/supremo-cli/dist/bin.js integrations email --provider resend --sender-email hello@example.invalid --environment production',
    `supremo auth password --user-id ${USER} --environment development`,
    'supremo integrations request RESEND_API_KEY --reason "Enviar emails" --target supabase --environment development',
    'supremo integrations request CUSTOM_TOKEN CUSTOM_KEY --reason "Integração solicitada" --target vercel --environment preview',
    'supremo integrations credentials', 'supremo secrets credentials',
    `supremo secrets status --request-id ${REQUEST}`,
    `supremo integrations apply ${REQUEST} --credential-id ${CREDENTIAL}`,
    `supremo secrets apply ${REQUEST} --credential-id ${CREDENTIAL}`,
    `supremo integrations revoke-credential ${CREDENTIAL}`,
    `supremo integrations request RESEND_API_KEY --reason "Enviar emails" --target supabase --credential-id ${CREDENTIAL}`,
    `supremo integrations email --provider resend --sender-email hello@example.invalid --environment development --credential-id ${CREDENTIAL}`,
  ])('recognizes metadata-only request: %s', command => expect(isDatabaseReadCommand(command)).toBe(true))
  it.each([
    'supremo integrations email --provider resend --sender-email hello@example.invalid',
    'supremo integrations email --provider resend --sender-email hello@example.invalid --environment development --password secret',
    'supremo integrations email --provider resend --provider resend --sender-email hello@example.invalid --environment development',
    'supremo integrations email --provider resend --sender-email hello@example.invalid --environment',
    'supremo integrations email toString value',
    `supremo auth password --user-id ${USER} --environment production`,
    `supremo auth password --user-id ${USER} --environment development --email hello@example.invalid`,
    `supremo auth password --user-id ${USER} --environment development; cat .env.local`,
    'supremo integrations request TOKEN --reason "Provider" --target supabase --value secret',
    'supremo integrations status',
    `supremo secrets apply ${REQUEST} --credential-id nope`,
    `supremo secrets apply ${REQUEST} --credential-id ${CREDENTIAL} --value secret`,
    `supremo auth password --user-id ${USER} --environment development --credential-id ${CREDENTIAL}`,
    `supremo integrations request KEY OTHER_KEY --reason Provider --target supabase --credential-id ${CREDENTIAL}`,
    'supremo integrations credentials --environment production',
    'supremo secrets status --request-id nope',
    `supremo secrets status --request-id ${REQUEST} --request-id ${USER}`,
    `supremo integrations revoke-credential ${CREDENTIAL}; cat .env.local`,
  ])('does not allow extra operations or credentials: %s', command => expect(isDatabaseReadCommand(command)).toBe(false))
})
