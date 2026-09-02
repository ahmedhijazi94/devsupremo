import { describe, expect, it } from 'vitest'
import {
  authorizeRestoreReport,
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

describe('authorizeRestoreReport — fail-closed contra IDOR (device autenticado ≠ autorizado)', () => {
  it('device é dono do projeto do restoreRequest → autoriza', () => {
    const d = authorizeRestoreReport({
      device: { ownerUserId: 'user-1' },
      restoreRequest: { projectOwnerUserId: 'user-1' },
    })
    expect(d).toEqual({ ok: true })
  })

  it('restoreRequestId inexistente → recusa (nunca revela se existe)', () => {
    const d = authorizeRestoreReport({
      device: { ownerUserId: 'user-1' },
      restoreRequest: null,
    })
    expect(d).toEqual({ ok: false, reason: 'restore_request_not_found' })
  })

  it('restoreRequest de OUTRO dono → recusa (device autenticado NÃO é suficiente — IDOR)', () => {
    const d = authorizeRestoreReport({
      device: { ownerUserId: 'user-1' },
      restoreRequest: { projectOwnerUserId: 'intruso' },
    })
    expect(d).toEqual({ ok: false, reason: 'device_owner_mismatch' })
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
