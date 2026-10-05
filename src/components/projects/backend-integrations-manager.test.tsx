// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
const mocks = vi.hoisted(() => ({ get: vi.fn(), credentials: vi.fn(), approve: vi.fn(), key: vi.fn(), oauth: vi.fn(), disconnect: vi.fn() }))
vi.mock('@/actions/integrations', () => ({ getIntegrations: mocks.get, approveIntegrationProposal: mocks.approve, approveIntegrationWithKey: mocks.key, approveOAuthIntegrationProposal: mocks.oauth, disconnectIntegration: mocks.disconnect }))
vi.mock('@/actions/secrets', () => ({ getProjectCredentials: mocks.credentials }))
import { BackendIntegrationsManager } from './backend-integrations-manager'
const projectId = '11111111-1111-4111-8111-111111111111', proposalId = '22222222-2222-4222-8222-222222222222', credentialId = '33333333-3333-4333-8333-333333333333'
const proposal = { id: proposalId, input: { projectId, environment: 'development', provider: 'resend', allowedSenders: ['sender@example.com'], allowedRecipients: ['recipient@example.com'], allowedRepositories: [] }, status: 'pending', connectionId: null, createdAt: '2026-10-05T10:00:00Z', expiresAt: '2026-10-06T10:00:00Z', authorizationPath: '/projects/example/backend' }
beforeEach(() => {
  vi.resetAllMocks()
  mocks.get.mockResolvedValue({ ok: true, proposals: [proposal], connections: [], sessions: [] })
  mocks.credentials.mockResolvedValue({ credentials: [{ id: credentialId, name: 'RESEND_API_KEY', environment: 'development' }] })
  mocks.approve.mockResolvedValue({ ok: true }); mocks.key.mockResolvedValue({ ok: true }); mocks.disconnect.mockResolvedValue({ ok: true })
})
afterEach(cleanup)
describe('prepared integration owner approval', () => {
  it('shows exact destination and scope, accepts a protected key and immediately clears its field', async () => {
    render(<BackendIntegrationsManager projectId={projectId} />)
    const field = await screen.findByLabelText(/Chave da integração/)
    expect(field.getAttribute('type')).toBe('password')
    expect(screen.getByText('Remetentes: sender@example.com')).toBeTruthy()
    expect(screen.getByText('Destinatários de teste: recipient@example.com')).toBeTruthy()
    fireEvent.change(field, { target: { value: 'private-test-value' } })
    fireEvent.click(screen.getByRole('button', { name: 'Autorizar conexão' }))
    await waitFor(() => expect(mocks.key).toHaveBeenCalledWith({ projectId, proposalId, value: 'private-test-value' }))
    expect((field as HTMLInputElement).value).toBe(''); expect(document.body.textContent).not.toContain('private-test-value')
    expect(mocks.approve).not.toHaveBeenCalled()
  })
  it('reuses a vault reference without asking for a secret again', async () => {
    render(<BackendIntegrationsManager projectId={projectId} />)
    fireEvent.change(await screen.findByRole('combobox'), { target: { value: credentialId } })
    expect(screen.queryByLabelText(/Chave da integração/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Autorizar conexão' }))
    await waitFor(() => expect(mocks.approve).toHaveBeenCalledWith({ projectId, proposalId, credentialId }))
    expect(mocks.key).not.toHaveBeenCalled()
  })
  it('shows OAuth account and destinations as consent text, without a technical contract form', async () => {
    mocks.get.mockResolvedValue({ ok: true, proposals: [{ ...proposal, input: { ...proposal.input, provider: 'generic', contract: { origin: 'https://api.example.com', identity: { account: 'account-123' }, operations: [{ name: 'settings', method: 'PATCH' }] }, oauth: { providerKey: 'example', scopes: ['settings:write'], authorization: { origin: 'https://auth.example.com' }, token: { origin: 'https://token.example.com' } } } }], connections: [], sessions: [] })
    mocks.oauth.mockResolvedValue({ ok: false, error: 'Conta não autorizada.' })
    render(<BackendIntegrationsManager projectId={projectId} />)
    expect(await screen.findByText('Conta: account-123')).toBeTruthy()
    expect(screen.getByText('Destino: https://api.example.com')).toBeTruthy()
    expect(screen.queryByRole('textbox')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Autorizar conta' }))
    await waitFor(() => expect(mocks.oauth).toHaveBeenCalledWith({ projectId, proposalId }))
    expect((await screen.findByRole('alert')).textContent).toContain('Conta não autorizada.')
  })
  it('keeps uncertain delivery separate from acceptance and explains local disconnection', async () => {
    mocks.get.mockResolvedValue({ ok: true, proposals: [], connections: [{ id: credentialId, provider: 'resend', environment: 'development', revokedAt: null, accountIdentityVerified: false }], sessions: [{ operationId: proposalId, operation: 'resend-send-test', status: 'verifying', evidence: { messageAccepted: true, messageDelivered: false } }] })
    render(<BackendIntegrationsManager projectId={projectId} />)
    expect(await screen.findByText('A entrega final ainda não foi confirmada.')).toBeTruthy()
    expect(screen.getByText('Desvincular bloqueia novos usos aqui. A chave e os recursos no provedor continuam existentes.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Desvincular do Supremo' }))
    await waitFor(() => expect(mocks.disconnect).toHaveBeenCalledWith({ projectId, connectionId: credentialId }))
  })
  it('does not report a successful load when server authorization failed', async () => {
    mocks.get.mockResolvedValue({ ok: false, error: 'Projeto não autorizado.' })
    render(<BackendIntegrationsManager projectId={projectId} />)
    expect((await screen.findByRole('alert')).textContent).toContain('Projeto não autorizado.')
    expect(screen.queryByRole('button', { name: 'Autorizar conexão' })).toBeNull()
  })
})
