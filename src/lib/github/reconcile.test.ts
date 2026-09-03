import { describe, expect, it, vi } from 'vitest'
import {
  checkpointStatusFromReconcile,
  isReconcilable,
  reconcileProjectPr,
  resolveRequiredChecks,
  selectReconcilable,
} from './reconcile'
import type { MergeGateway } from './merge-controller'
import type { CheckRun } from './merge-policy'

describe('seleção do fallback periódico', () => {
  it('isReconcilable só para estados relevantes', () => {
    expect(isReconcilable('ci_running')).toBe(true)
    expect(isReconcilable('merge_pending')).toBe(true)
    expect(isReconcilable('validated')).toBe(true)
    expect(isReconcilable('merged')).toBe(false)
    expect(isReconcilable('development')).toBe(false)
    expect(isReconcilable(null)).toBe(false)
  })

  it('selectReconcilable pega só projetos com PR aberta em estado relevante', () => {
    const projects = [
      { id: 'a', integration_state: 'ci_running', pr_number: 1 }, // ✓
      { id: 'b', integration_state: 'merged', pr_number: 2 }, // ✗ estado
      { id: 'c', integration_state: 'merge_pending', pr_number: null }, // ✗ sem PR
      { id: 'd', integration_state: null, pr_number: 4 }, // ✗ estado nulo
      { id: 'e', integration_state: 'validated', pr_number: 5 }, // ✓
    ]
    expect(selectReconcilable(projects).map((p) => p.id)).toEqual(['a', 'e'])
  })
})

describe('resolveRequiredChecks — fonte real do template', () => {
  it('modo completo exige todos os gates', () => {
    const full = resolveRequiredChecks({ fastMode: false, rlsMode: 'block' })
    expect(full).toContain('Testes e cobertura')
    expect(full).toContain('End-to-end')
    expect(full).toContain('Políticas RLS')
  })

  it('sem sinal → fail-safe estrito (conjunto completo)', () => {
    expect(resolveRequiredChecks({}).length).toBeGreaterThanOrEqual(
      resolveRequiredChecks({ fastMode: true, rlsMode: 'warn' }).length,
    )
  })

  it('modo rápido exige ao menos os gates baratos + build', () => {
    const fast = resolveRequiredChecks({ fastMode: true, rlsMode: 'warn' })
    expect(fast).toContain('Build de produção')
    expect(fast).toContain('Varredura de segredos')
  })
})

/**
 * E2E real: depois que a execução em main ficou verde, o projeto mostrou
 * READY/tudo verde, mas o Histórico continuou em "Testando". Causa raiz: a
 * reconciliação sempre gravou `integration_state` no PROJETO
 * (`writeIntegrationMeta`), mas nada gravava de volta no CHECKPOINT —
 * `integration_status` era escrito UMA vez no publish ('ci_running') e nunca
 * mais tocado. `checkpointStatusFromReconcile` é a decisão PURA que resolve
 * isso: o que gravar no checkpoint a partir do resultado da reconciliação.
 */
describe('checkpointStatusFromReconcile — Histórico reconcilia pra Integrado só após merge válido', () => {
  it('merged: true → push_status vira "integrated" (só quando o merge de fato aconteceu)', () => {
    expect(checkpointStatusFromReconcile({ state: 'merged', merged: true })).toEqual({
      pushStatus: 'integrated',
      integrationStatus: 'merged',
    })
  })

  it('ainda não mesclado (ci_running) → integration_status avança, push_status NUNCA antecipa "integrated"', () => {
    expect(checkpointStatusFromReconcile({ state: 'ci_running', merged: false })).toEqual({
      pushStatus: null,
      integrationStatus: 'ci_running',
    })
  })

  it('validated (tudo verde, ainda não mesclado) → integration_status avança, mas push_status continua null — nunca declara Integrado antes da hora', () => {
    expect(checkpointStatusFromReconcile({ state: 'validated', merged: false })).toEqual({
      pushStatus: null,
      integrationStatus: 'validated',
    })
  })

  it('ci_failed/security_blocked → integration_status reflete a falha real (nunca fica preso em ci_running)', () => {
    expect(checkpointStatusFromReconcile({ state: 'ci_failed', merged: false })).toEqual({
      pushStatus: null,
      integrationStatus: 'ci_failed',
    })
    expect(checkpointStatusFromReconcile({ state: 'security_blocked', merged: false })).toEqual({
      pushStatus: null,
      integrationStatus: 'security_blocked',
    })
  })

  it('merged: false NUNCA produz pushStatus "integrated", seja qual for o state — fail-closed', () => {
    const states = [
      'development',
      'ci_running',
      'ci_failed',
      'security_blocked',
      'validated',
      'merge_pending',
      'unmanaged_main_change',
    ] as const
    for (const state of states) {
      expect(checkpointStatusFromReconcile({ state, merged: false }).pushStatus).toBeNull()
    }
  })
})

describe('reconcileProjectPr — caminho único, re-lê pelo gateway', () => {
  const SHA = 'a'.repeat(40)
  const green: CheckRun[] = [{ name: 'G', status: 'completed', conclusion: 'success' }]

  function gw(): MergeGateway {
    return {
      getPullRequest: vi.fn(async () => ({ headSha: SHA, nodeId: 'n', merged: false, state: 'open' })),
      getChecks: vi.fn(async () => ({ checks: green, headSha: SHA })),
      allowAutoMerge: vi.fn(async () => true),
      enableNativeAutoMerge: vi.fn(async () => true),
      merge: vi.fn(async () => ({ sha: SHA })),
    }
  }

  it('delega para reconcileMerge relendo o estado real e registra eventos', async () => {
    const gateway = gw()
    const events: string[] = []
    const r = await reconcileProjectPr({
      gateway,
      prNumber: 7,
      requiredChecks: ['G'],
      mode: 'supremo_managed',
      log: { event: (n) => events.push(n) },
    })
    // relê o estado (não confia no payload do webhook)
    expect(gateway.getPullRequest).toHaveBeenCalled()
    expect(gateway.getChecks).toHaveBeenCalled()
    expect(r.merged).toBe(true)
    expect(events).toContain('reconciliation_started')
    expect(events).toContain('reconciliation_result')
  })

  it('modo native não mescla ele mesmo — habilita auto-merge nativo', async () => {
    const gateway = gw()
    await reconcileProjectPr({
      gateway,
      prNumber: 1,
      requiredChecks: ['G'],
      mode: 'native',
    })
    expect(gateway.enableNativeAutoMerge).toHaveBeenCalled()
    expect(gateway.merge).not.toHaveBeenCalled()
  })
})
