import { describe, expect, it } from 'vitest'
import {
  authorizeRestoreRequest,
  humanCheckpointStatus,
  humanRestoreStatus,
} from './restore'

describe('authorizeRestoreRequest — fail-closed', () => {
  it('checkpoint alvo do MESMO projeto → autoriza', () => {
    const d = authorizeRestoreRequest({
      projectId: 'proj-A',
      target: { id: 'cpB', projectId: 'proj-A' },
    })
    expect(d).toEqual({ ok: true })
  })

  it('checkpoint inexistente → recusa', () => {
    const d = authorizeRestoreRequest({ projectId: 'proj-A', target: null })
    expect(d).toEqual({ ok: false, reason: 'checkpoint_not_found' })
  })

  it('checkpoint de OUTRO projeto → recusa (nunca restaura entre projetos)', () => {
    const d = authorizeRestoreRequest({
      projectId: 'proj-A',
      target: { id: 'cpB', projectId: 'proj-B' },
    })
    expect(d).toEqual({ ok: false, reason: 'project_mismatch' })
  })
})

describe('humanCheckpointStatus — a UI nunca mostra jargão de Git', () => {
  it('publishing → Salvando', () => {
    expect(humanCheckpointStatus('publishing', null)).toBe('Salvando')
  })
  it('published sem integration_status → Publicando', () => {
    expect(humanCheckpointStatus('published', null)).toBe('Publicando')
  })
  it('ci_running/merge_pending → Testando', () => {
    expect(humanCheckpointStatus('published', 'ci_running')).toBe('Testando')
    expect(humanCheckpointStatus('published', 'merge_pending')).toBe('Testando')
  })
  it('merged ou integrated → Integrado', () => {
    expect(humanCheckpointStatus('published', 'merged')).toBe('Integrado')
    expect(humanCheckpointStatus('integrated', null)).toBe('Integrado')
  })
  it('failed ou security_blocked → Falhou', () => {
    expect(humanCheckpointStatus('failed', null)).toBe('Falhou')
    expect(humanCheckpointStatus('published', 'security_blocked')).toBe('Falhou')
  })
})

describe('humanRestoreStatus', () => {
  it('pending/claimed → Restaurando', () => {
    expect(humanRestoreStatus('pending')).toBe('Restaurando')
    expect(humanRestoreStatus('claimed')).toBe('Restaurando')
  })
  it('applied → Restaurado', () => {
    expect(humanRestoreStatus('applied')).toBe('Restaurado')
  })
  it('failed → Falhou', () => {
    expect(humanRestoreStatus('failed')).toBe('Falhou')
  })
})
