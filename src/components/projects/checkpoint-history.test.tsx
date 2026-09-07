// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CheckpointHistoryItem } from '@/actions/checkpoints'

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
})
