// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AutomationStatus } from '@/actions/automation'
import { capabilities, type OperationPolicy } from '@/lib/backend-operations/contract'

const mocks = vi.hoisted(() => ({
  get: vi.fn<(raw: unknown) => Promise<AutomationStatus>>(),
  save: vi.fn<(raw: unknown) => Promise<{ ok: true; revision: string }>>(),
}))
vi.mock('@/actions/automation', () => ({ getProjectAutomation: mocks.get, saveProjectAutomation: mocks.save }))
vi.mock('@/actions/operation-approvals', () => ({
  getProjectOperationApprovals: vi.fn(async () => ({ ok: true, approvals: [], observedAt: '2026-10-05T12:00:00Z' })),
  decideProjectOperationApproval: vi.fn(),
}))
import { BackendAutomation } from './automation-panel'

const projectId = '11111111-1111-4111-8111-111111111111'
const policy: OperationPolicy = {
  id: '22222222-2222-4222-8222-222222222222',
  ownerId: '33333333-3333-4333-8333-333333333333',
  projectId,
  revision: '44444444-4444-4444-8444-444444444444',
  environment: 'development', enabled: false, capabilities: ['engine.update'],
  resources: ['engine.tools'], deviceIds: ['55555555-5555-4555-8555-555555555555'],
  maxRows: 17, maxOperationsPerHour: 42,
}
function status(environment: 'development' | 'production' = 'development'): AutomationStatus {
  return { ok: true, environment, projectRef: 'owned-ref', policy: { ...policy, environment }, operations: [],
    devices: [{ id: policy.deviceIds[0]!, label: 'Computador autorizado' }] }
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.get.mockResolvedValue(status())
  mocks.save.mockResolvedValue({ ok: true, revision: '66666666-6666-4666-8666-666666666666' })
})
afterEach(cleanup)

describe('perfil completo de desenvolvimento', () => {
  it('remove a restrição de recursos ao selecionar o perfil e preserva os computadores e limites', async () => {
    render(<BackendAutomation projectId={projectId} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Selecionar perfil completo de desenvolvimento' }))
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('')
    expect(mocks.save).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Salvar autorização' }))
    await waitFor(() => expect(mocks.save).toHaveBeenCalledExactlyOnceWith({
      projectId, environment: 'development', expectedRevision: policy.revision, enabled: true,
      capabilities: [...capabilities], resources: [], deviceIds: policy.deviceIds,
      maxRows: 17, maxOperationsPerHour: 42,
    }))
  })

  it('preserva as restrições salvas quando o dono não seleciona o perfil completo', async () => {
    render(<BackendAutomation projectId={projectId} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Salvar autorização' }))
    await waitFor(() => expect(mocks.save).toHaveBeenCalledExactlyOnceWith({
      projectId, environment: 'development', expectedRevision: policy.revision, enabled: false,
      capabilities: ['engine.update'], resources: ['engine.tools'], deviceIds: policy.deviceIds,
      maxRows: 17, maxOperationsPerHour: 42,
    }))
  })

  it('não oferece o perfil de desenvolvimento em produção', async () => {
    mocks.get.mockResolvedValue(status('production'))
    render(<BackendAutomation projectId={projectId} />)
    await screen.findByRole('button', { name: 'Salvar autorização' })
    expect(screen.queryByRole('button', { name: 'Selecionar perfil completo de desenvolvimento' })).toBeNull()
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('engine.tools')
    expect(mocks.save).not.toHaveBeenCalled()
  })
})
