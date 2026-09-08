// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CheckpointHistoryItem } from '@/actions/checkpoints'
import { presentLocalDiagnostic } from '@/lib/checkpoint/local-diagnostic'

const mocks = vi.hoisted(() => ({ list: vi.fn() }))
vi.mock('@/actions/checkpoints', () => ({ listProjectCheckpoints: mocks.list }))
vi.mock('./restore-checkpoint-button', () => ({ RestoreCheckpointButton: () => <button>Restaurar</button> }))
import { CheckpointHistory } from './checkpoint-history'

const checkpoint: CheckpointHistoryItem = {
  id: 'local', parentCheckpointId: null, summary: 'Alteração salva no computador',
  riskLevel: 'low', status: 'Salvo localmente', migrations: [], prNumber: null,
  createdAt: '2026-09-06T00:00:00.000Z', restoredFromCheckpointId: null,
  localState: 'failed', validationLabel: 'Pendência local', validationSummary: 'Envio pendente de correção.', canRestore: false,
}
afterEach(() => { cleanup(); vi.clearAllMocks() })
describe('checkpoint history visible before publication', () => {
  it('shows approved validation awaiting integration without announcing running tests or completed merge', async () => {
    const published: CheckpointHistoryItem = {
      id: 'published', parentCheckpointId: null, summary: 'Despesas', riskLevel: 'high',
      status: 'Aguardando integração', migrations: [], prNumber: 1,
      createdAt: '2026-09-08T20:01:00.000Z', restoredFromCheckpointId: null,
      validationSummary: 'Validação aprovada. Aguardando integração.', canRestore: true,
    }
    mocks.list.mockResolvedValue({ items: [published] })
    render(<CheckpointHistory projectId="project" items={[published]} />)
    expect(await screen.findByText('Aguardando integração')).toBeTruthy()
    expect(screen.getByText('Validação aprovada. Aguardando integração.')).toBeTruthy()
    expect(screen.queryByText('Testando')).toBeNull()
    expect(screen.queryByText('Integrado')).toBeNull()
    expect(screen.getByRole('button', { name: 'Restaurar' })).toBeTruthy()
  })
  it('updates an initially empty history and gives local metadata no restore or risk approval', async () => {
    mocks.list.mockResolvedValue({ items: [checkpoint] })
    render(<CheckpointHistory projectId="project" items={[]} />)
    expect(await screen.findByText('Pendência local')).toBeTruthy()
    expect(screen.getByText('Envio pendente de correção.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Restaurar' })).toBeNull()
    expect(screen.queryByText('LOW')).toBeNull()
  })
  it('shows connection failures while keeping the last received checkpoint visible', async () => {
    mocks.list.mockRejectedValue(new Error('offline'))
    render(<CheckpointHistory projectId="project" items={[checkpoint]} />)
    expect((await screen.findByRole('status')).textContent).toContain('Não foi possível atualizar')
    expect(screen.getByText('Pendência local')).toBeTruthy()
  })
  it('only offers restore for a published target explicitly authorized by the server', async () => {
    const published = { ...checkpoint }
    delete published.localState
    mocks.list.mockResolvedValue({ items: [{ ...published, status: 'Integrado', canRestore: true }] })
    render(<CheckpointHistory projectId="project" items={[]} />)
    expect(await screen.findByRole('button', { name: 'Restaurar' })).toBeTruthy()
  })
  it('shows the failing stage, specific cause and next step without presenting it as a CI result', async () => {
    const diagnosed = { ...checkpoint, validationDiagnostic: presentLocalDiagnostic('acceptance_test_path') }
    mocks.list.mockResolvedValue({ items: [diagnosed] })
    render(<CheckpointHistory projectId="project" items={[diagnosed]} />)
    expect(await screen.findByText('Etapa: Contrato de testes')).toBeTruthy()
    expect(screen.getByText(/Test path must name a project test/)).toBeTruthy()
    expect(screen.getByText(/Publicação aguarda correção e nova validação/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Restaurar' })).toBeNull()
    expect(screen.queryByText(/motivo detalhado ainda não foi recebido/)).toBeNull()
  })
  it('explains when the legacy device has not sent a detailed cause yet', async () => {
    mocks.list.mockResolvedValue({ items: [checkpoint] })
    render(<CheckpointHistory projectId="project" items={[checkpoint]} />)
    expect(await screen.findByText(/motivo detalhado ainda não foi recebido/)).toBeTruthy()
  })
})
