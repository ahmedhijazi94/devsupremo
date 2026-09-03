import { describe, expect, it } from 'vitest'
import {
  authorizeRestoreReport,
  authorizeRestoreRequest,
  computeActiveCheckpointId,
  humanCheckpointStatus,
  humanRestoreStatus,
  type ActiveCheckpointInput,
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

  // Estes 3 ramos só passaram a ser exercitáveis de verdade depois do fix da
  // reconciliação (checkpointStatusFromReconcile grava result.state completo,
  // não mais só 'ci_running' hardcoded) — sem cobertura aqui, um CI vermelho
  // reconciliado cairia no default 'Publicando' (sugerindo que nada rodou
  // ainda) em vez de 'Falhou'.
  it('ci_failed → Falhou (mesmo tratamento de security_blocked — CI vermelho é falha, não "ainda publicando")', () => {
    expect(humanCheckpointStatus('published', 'ci_failed')).toBe('Falhou')
  })
  it('validated (tudo verde, ainda não mesclado) → Testando, NUNCA Integrado antes do merge de verdade', () => {
    expect(humanCheckpointStatus('published', 'validated')).toBe('Testando')
  })
  it('unmanaged_main_change (anomalia — main mudou fora do Merge Controller) → Testando, nunca Integrado sem confirmação', () => {
    expect(humanCheckpointStatus('published', 'unmanaged_main_change')).toBe('Testando')
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

/**
 * v3-10 (correção do pedido original): o badge "Ativo" representa o estado
 * ATUALMENTE aplicado no projeto — não a operação não-terminal mais recente.
 * Um checkpoint `integrated` PODE continuar Ativo; um restore devolve o Ativo
 * pro checkpoint-ALVO restaurado, nunca fica no registro técnico "Restaurar".
 */
describe('computeActiveCheckpointId — badge "Ativo" (v3-10)', () => {
  const item = (
    id: string,
    createdAt: string,
    restoredFromCheckpointId: string | null = null,
  ): ActiveCheckpointInput => ({ id, createdAt, restoredFromCheckpointId })

  it('vazio → null', () => {
    expect(computeActiveCheckpointId([])).toBeNull()
  })

  it('vários itens, nenhum é restore → o Ativo é o mais recente por createdAt (integrated incluso)', () => {
    const items = [
      item('cpA', '2026-01-01T00:00:00.000Z'),
      item('cpB', '2026-01-02T00:00:00.000Z'),
      item('cpC', '2026-01-03T00:00:00.000Z'), // mais novo
    ]
    // ordem de entrada embaralhada de propósito — a função ordena por createdAt,
    // nunca confia na ordem em que o chamador passou a lista.
    expect(computeActiveCheckpointId([items[1]!, items[2]!, items[0]!])).toBe('cpC')
  })

  it('checkpoint `integrated` PODE continuar Ativo — status/push nunca entram na decisão', () => {
    // computeActiveCheckpointId nem recebe pushStatus: um item "integrated" é
    // só mais um item com id/createdAt/restoredFromCheckpointId normais.
    const items = [item('cpA', '2026-01-01T00:00:00.000Z'), item('cpB', '2026-01-02T00:00:00.000Z')]
    expect(computeActiveCheckpointId(items)).toBe('cpB')
  })

  it('o mais recente é um "Restaurar X" → o Ativo é X (o alvo), NUNCA o registro técnico do restore', () => {
    const items = [
      item('cpA', '2026-01-01T00:00:00.000Z'),
      item('cpB', '2026-01-02T00:00:00.000Z'),
      // "Restaurar A" — mais novo por createdAt, mas aponta pra cpA
      item('cpE', '2026-01-03T00:00:00.000Z', 'cpA'),
    ]
    expect(computeActiveCheckpointId(items)).toBe('cpA')
    expect(computeActiveCheckpointId(items)).not.toBe('cpE')
  })

  it('nova alteração depois de um restore → o Ativo migra pro checkpoint novo, sai do alvo restaurado', () => {
    const items = [
      item('cpA', '2026-01-01T00:00:00.000Z'),
      item('cpB', '2026-01-02T00:00:00.000Z'),
      item('cpE', '2026-01-03T00:00:00.000Z', 'cpA'), // "Restaurar A"
      item('cpF', '2026-01-04T00:00:00.000Z'), // nova alteração comum
    ]
    expect(computeActiveCheckpointId(items)).toBe('cpF')
  })

  it('no máximo um Ativo — nunca duas entradas da lista batem com o id retornado', () => {
    const items = [
      item('cpA', '2026-01-01T00:00:00.000Z'),
      item('cpB', '2026-01-02T00:00:00.000Z'),
      item('cpE', '2026-01-03T00:00:00.000Z', 'cpA'),
    ]
    const activeId = computeActiveCheckpointId(items)
    expect(items.filter((i) => i.id === activeId)).toHaveLength(1)
  })

  it('exemplo completo do pedido: A(dark)→B(light) [B ativo] → Restaurar A [A ativo] → cria C [C ativo]', () => {
    const afterB = [item('cpA', '2026-01-01T00:00:00.000Z'), item('cpB', '2026-01-02T00:00:00.000Z')]
    expect(computeActiveCheckpointId(afterB)).toBe('cpB')

    const afterRestoreA = [
      ...afterB,
      item('cpE', '2026-01-03T00:00:00.000Z', 'cpA'), // "Restaurar A"
    ]
    expect(computeActiveCheckpointId(afterRestoreA)).toBe('cpA')

    const afterC = [...afterRestoreA, item('cpC', '2026-01-04T00:00:00.000Z')]
    expect(computeActiveCheckpointId(afterC)).toBe('cpC')
  })
})
