import { describe, expect, it } from 'vitest'
import { authPasswordRequest, emailIntegrationRequest } from './integration-request'
import { isDatabaseReadCommand } from './database-request'
import { secretResponse } from './project-service-request'

const USER = 'aabbccdd-1111-4111-8111-123456789abc'
const PROJECT = '11111111-1111-4111-8111-111111111111'
const ISSUER = 'https://supremo.example.invalid'
const SMTP = { provider: 'resend', senderEmail: 'hello@example.invalid', senderName: 'Meu app', environment: 'development' }

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
  it('rejects unknown fields inside configuration and responses for another project', () => {
    const entry = { id: '22222222-2222-4222-8222-222222222222', ...emailIntegrationRequest(SMTP).requests[0],
      targetRef: 'owned-ref', status: 'pending', configuration: { kind: 'supabase-smtp', ...SMTP, password: 'never-return' } }
    expect(() => secretResponse({ projectId: PROJECT, requests: [entry] }, PROJECT, ISSUER)).toThrow()
    expect(() => secretResponse({ projectId: USER, requests: [] }, PROJECT, ISSUER)).toThrow()
  })
})

describe('secure field requests do not launch app QA or recovery', () => {
  it.each([
    'supremo integrations email --provider resend --sender-email hello@example.invalid --sender-name "Meu app" --environment development',
    'node node_modules/supremo-cli/dist/bin.js integrations email --provider resend --sender-email hello@example.invalid --environment production',
    `supremo auth password --user-id ${USER} --environment development`,
    'supremo integrations request RESEND_API_KEY --reason "Enviar emails" --target supabase --environment development',
    'supremo integrations request CUSTOM_TOKEN CUSTOM_KEY --reason "Integração solicitada" --target vercel --environment preview',
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
  ])('does not allow extra operations or credentials: %s', command => expect(isDatabaseReadCommand(command)).toBe(false))
})
