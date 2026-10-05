// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ target: vi.fn(), request: vi.fn() }))
vi.mock('@/actions/automation', () => ({ getProjectAutomation: mocks.target }))
vi.mock('@/actions/auth-provider-request', () => ({ requestAuthProvider: mocks.request }))
import { BackendAuthProvider } from './backend-auth-provider'
const projectId = '11111111-1111-4111-8111-111111111111'
beforeEach(() => {
  vi.resetAllMocks()
  mocks.target.mockResolvedValue({ ok: true, environment: 'development', projectRef: 'owned-ref' })
  mocks.request.mockResolvedValue({ ok: true, requestId: 'request', status: 'pending' })
})
afterEach(cleanup)
const show = () => { render(<BackendAuthProvider projectId={projectId} />); fireEvent.click(screen.getByText('Login com Google ou GitHub')) }
it('prepares the selected provider using public metadata and the displayed environment', async () => {
  show()
  expect(await screen.findByText('Desenvolvimento · owned-ref')).toBeTruthy()
  fireEvent.change(screen.getByLabelText('Provedor de login'), { target: { value: 'github' } })
  fireEvent.change(screen.getByLabelText('Client ID público'), { target: { value: 'public-client' } })
  expect(document.querySelector('input[type=password]')).toBeNull()
  const changed = vi.fn(); window.addEventListener('supremo:secret-requests-changed', changed)
  try {
    fireEvent.click(screen.getByRole('button', { name: 'Preparar campo seguro' }))
    await waitFor(() => expect(mocks.request).toHaveBeenCalledWith({ projectId, expectedRef: 'owned-ref', environment: 'development', provider: 'github', clientId: 'public-client' }))
    expect(await screen.findByRole('link', { name: 'Ir para Configuração segura' })).toHaveProperty('hash', '#secrets')
    expect(screen.getByRole('status').textContent).toContain('client secret em Configuração segura')
    expect(changed).toHaveBeenCalledOnce()
  } finally { window.removeEventListener('supremo:secret-requests-changed', changed) }
})
it('does not prepare a request without a confirmed environment', async () => {
  mocks.target.mockResolvedValue({ ok: true, environment: 'unknown', projectRef: null })
  show()
  expect(await screen.findByText('O ambiente ainda não foi confirmado.')).toBeTruthy()
  expect((screen.getByRole('button', { name: 'Preparar campo seguro' }) as HTMLButtonElement).disabled).toBe(true)
  expect(mocks.request).not.toHaveBeenCalled()
})
it('keeps server refusal visible without promising a prepared field', async () => {
  mocks.request.mockResolvedValue({ error: 'O vínculo mudou.' })
  show(); await screen.findByText('Desenvolvimento · owned-ref')
  fireEvent.change(screen.getByLabelText('Client ID público'), { target: { value: 'public-client' } })
  fireEvent.click(screen.getByRole('button', { name: 'Preparar campo seguro' }))
  expect(await screen.findByText('O vínculo mudou.')).toBeTruthy()
  expect(screen.queryByRole('link')).toBeNull()
})
it('explains explicit rotation for an existing fulfilled field', async () => {
  mocks.request.mockResolvedValue({ ok: true, status: 'fulfilled' })
  show(); await screen.findByText('Desenvolvimento · owned-ref')
  fireEvent.change(screen.getByLabelText('Client ID público'), { target: { value: 'public-client' } })
  fireEvent.click(screen.getByRole('button', { name: 'Preparar campo seguro' }))
  expect(await screen.findByText(/dispense o pedido anterior/)).toBeTruthy()
})
it('ignores late environment responses and clears public drafts when the project changes', async () => {
  let complete!: (value: unknown) => void
  mocks.target.mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
  const { rerender } = render(<BackendAuthProvider projectId={projectId} />)
  fireEvent.change(screen.getByLabelText('Client ID público'), { target: { value: 'old-client' } })
  mocks.target.mockResolvedValue({ ok: true, environment: 'production', projectRef: 'next-ref' })
  rerender(<BackendAuthProvider projectId="22222222-2222-4222-8222-222222222222" />)
  await act(async () => { complete({ ok: true, environment: 'development', projectRef: 'stale-ref' }) })
  expect(await screen.findByText('Produção · next-ref')).toBeTruthy()
  expect(screen.queryByText(/stale-ref/)).toBeNull()
  expect((screen.getByLabelText('Client ID público') as HTMLInputElement).value).toBe('')
})
