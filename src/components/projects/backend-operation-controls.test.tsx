// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ target: vi.fn(), administer: vi.fn(), operation: vi.fn(), confirmed: vi.fn() }))
vi.mock('@/actions/automation', () => ({ getProjectAutomation: mocks.target }))
vi.mock('@/actions/backend-administration', () => ({ administerProjectBackend: mocks.administer }))
vi.mock('@/lib/project-backend/browser-operation', () => ({ browserOperation: mocks.operation }))
vi.mock('./backend-panels', () => ({ BackendUsers: () => null, BackendFunctions: () => null }))
vi.mock('./backend-auth-provider', () => ({ BackendAuthProvider: () => null }))
import { BackendUsersManager } from './backend-operation-controls'
const projectId = '11111111-1111-4111-8111-111111111111', operationId = '22222222-2222-4222-8222-222222222222'
beforeEach(() => {
  vi.resetAllMocks()
  mocks.target.mockResolvedValue({ ok: true, environment: 'development', projectRef: 'owned-project' })
  mocks.operation.mockResolvedValue({ id: operationId, confirmed: mocks.confirmed })
})
afterEach(cleanup)
it.each(['succeeded', 'uncertain'])('submits an exact invitation and reports its %s receipt without claiming email delivery', async state => {
  mocks.administer.mockResolvedValue({ ok: true, data: { receipt: { state, message: 'Resultado a confirmar' } } })
  render(<BackendUsersManager projectId={projectId} />)
  fireEvent.change(screen.getByLabelText('Ação'), { target: { value: 'auth-invite' } })
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'invite@example.com' } })
  fireEvent.change(screen.getByLabelText(/URL após aceitar/), { target: { value: 'https://app.example.com/invite' } })
  const submit = screen.getByRole('button', { name: 'Aplicar ao recurso indicado', hidden: true })
  await waitFor(() => expect((submit as HTMLButtonElement).disabled).toBe(false))
  fireEvent.submit(submit.closest('form')!)
  await waitFor(() => expect(mocks.administer).toHaveBeenCalledWith({ projectId, expectedRef: 'owned-project', operationId, kind: 'auth', options: { operation: 'auth-invite', environment: 'development', email: 'invite@example.com', redirectTo: 'https://app.example.com/invite' } }))
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain(state === 'succeeded' ? 'entrega do email ainda não foi comprovada' : 'Resultado a confirmar'))
  expect(screen.getByRole('status').textContent).toContain('Convite para invite@example.com:')
  expect(mocks.confirmed).toHaveBeenCalledTimes(state === 'succeeded' ? 1 : 0)
})
it.each(['succeeded', 'uncertain', 'lost-response'])('locks pending invitation fields and identifies the submitted recipient after %s', async state => {
  let finish!: (value: unknown) => void
  let fail!: (error: Error) => void
  mocks.administer.mockImplementationOnce(() => new Promise((resolve, reject) => { finish = resolve; fail = reject }))
  render(<BackendUsersManager projectId={projectId} />)
  const action = screen.getByLabelText('Ação') as HTMLSelectElement
  fireEvent.change(action, { target: { value: 'auth-invite' } })
  const email = screen.getByLabelText('Email') as HTMLInputElement
  const redirect = screen.getByLabelText(/URL após aceitar/) as HTMLInputElement
  fireEvent.change(email, { target: { value: 'captured@example.com' } })
  fireEvent.change(redirect, { target: { value: 'https://app.example.com/invite' } })
  const submit = screen.getByRole('button', { name: 'Aplicar ao recurso indicado', hidden: true }) as HTMLButtonElement
  await waitFor(() => expect(submit.disabled).toBe(false))
  fireEvent.submit(submit.closest('form')!)
  await waitFor(() => expect(mocks.administer).toHaveBeenCalledOnce())
  expect(action.disabled).toBe(true)
  expect(email.disabled).toBe(true)
  expect(redirect.disabled).toBe(true)
  expect(submit.disabled).toBe(true)
  // Programmatic events bypass native disabled controls. Even then an in-flight
  // result must stay bound to its captured recipient, not the new draft.
  fireEvent.change(email, { target: { value: 'other@example.com' } })
  fireEvent.submit(submit.closest('form')!)
  expect(mocks.administer).toHaveBeenCalledOnce()
  expect(mocks.operation).toHaveBeenCalledOnce()
  expect(mocks.administer.mock.calls[0]?.[0]).toMatchObject({ options: { email: 'captured@example.com' } })
  await act(async () => {
    if (state === 'lost-response') fail(new Error('transport'))
    else finish({ ok: true, data: { receipt: { state, message: 'Resultado a confirmar' } } })
  })
  expect(screen.getByRole('status').textContent).toContain('Convite para captured@example.com:')
  expect(screen.getByRole('status').textContent).not.toContain('other@example.com')
  expect(mocks.confirmed).toHaveBeenCalledTimes(state === 'succeeded' ? 1 : 0)
  expect(action.disabled).toBe(false)
  expect(email.disabled).toBe(false)
})
