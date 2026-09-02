import { describe, expect, it, vi } from 'vitest'
import {
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
