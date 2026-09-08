import type { ValidationAuthority } from './trusted-policy'
import {
  evaluateMergeEligibility,
  type CheckRun,
  type IntegrationState,
  type MergeDecision,
  type MergeMode,
} from './merge-policy'

/**
 * Merge Controller da Supremo v3 (seções 5, 9, 10) — a barreira INDEPENDENTE que
 * integra na `main`. Roda em BACKGROUND (Control Plane), nunca na sessão do agente:
 * o agente empurra e segue; este controlador reconcilia depois.
 *
 * - modo NATIVE_GITHUB: preserva a proteção de branch nativa e também exige
 *   a política independente do motor antes do merge com SHA esperado;
 * - modo SUPREMO_MANAGED: valida os checks reais do HEAD exato e mescla via API com
 *   o SHA esperado (anti-TOCTOU), revalidando o HEAD imediatamente antes do merge.
 *
 * A decisão vem SEMPRE de `evaluateMergeEligibility` (checks reais do GitHub), nunca
 * de "o agente disse que passou".
 */

/** Operações do GitHub que o controlador precisa — injetável para testes. */
export interface MergeGateway {
  getPullRequest(prNumber: number): Promise<{
    headSha: string
    /** Branch de origem da PR (ex.: `supremo/cp-<sha>`) — usado só pro
     * cleanup de integration branch (v3-13), nunca pra decisão de merge. */
    headRef: string
    nodeId: string
    merged: boolean
    state: string
    autoMergeEnabled?: boolean
  }>
  /** Checks do ref dado + o SHA a que pertencem (headSha). */
  getChecks(ref: string): Promise<{ checks: CheckRun[]; headSha: string }>
  /** Independent policy at the immutable candidate SHA; absent proof fails closed. */
  verifyPolicy?(headSha: string): Promise<ValidationAuthority>
  /** Native execution is safe only while GitHub itself requires every gate. */
  hasRequiredChecks?(required: readonly string[]): Promise<boolean>
  disableNativeAutoMerge?(nodeId: string): Promise<boolean>
  allowAutoMerge(): Promise<boolean>
  enableNativeAutoMerge(nodeId: string): Promise<boolean>
  merge(prNumber: number, expectedSha: string): Promise<{ sha: string }>
  /** Apaga uma branch. Silencioso se ela já não existe (idempotente) — ver
   * `github/client.ts#deleteBranch`. Só chamado pelo cleanup pós-merge (v3-13),
   * nunca pela decisão de merge em si. */
  deleteBranch(branch: string): Promise<void>
}

export interface ReconcileResult {
  /** Exact PR revision observed by this reconciliation, never a webhook hint. */
  headSha: string
  state: IntegrationState
  decision: MergeDecision | 'noop'
  merged: boolean
  reasons: string[]
}

export async function reconcileMerge(
  gw: MergeGateway,
  input: { prNumber: number; requiredChecks: readonly string[]; mode: MergeMode },
): Promise<ReconcileResult> {
  const { prNumber, requiredChecks, mode } = input

  const pr = await gw.getPullRequest(prNumber)
  if (pr.merged) {
    return { headSha: pr.headSha, state: 'merged', decision: 'noop', merged: true, reasons: ['PR já mesclada.'] }
  }

  // Withdraw legacy native auto-merge: it can otherwise merge a later SHA
  // without our independent policy approval. Both modes now use expected-SHA
  // integration while retaining GitHub's branch protections underneath.
  if (pr.autoMergeEnabled && await gw.disableNativeAutoMerge?.(pr.nodeId) !== true) {
    return { headSha: pr.headSha, state: 'security_blocked', decision: 'blocked', merged: false,
      reasons: ['GitHub não confirmou a desativação do auto-merge antigo; integração suspensa.'] }
  }
  if (mode === 'native' && await gw.hasRequiredChecks?.(requiredChecks) !== true) {
    return { headSha: pr.headSha, state: 'security_blocked', decision: 'blocked', merged: false,
      reasons: ['A proteção nativa não comprova todos os gates obrigatórios.'] }
  }

  const checks = await gw.getChecks(pr.headSha)
  const evaluation = evaluateMergeEligibility({
    requiredChecks,
    checkRuns: checks.checks,
    prHeadSha: pr.headSha,
    validatedSha: checks.headSha,
  })


  // ── SUPREMO_MANAGED: nós validamos e mesclamos ───────────────────────────────
  if (evaluation.decision !== 'merge') {
    return {
      headSha: pr.headSha,
      state: evaluation.state,
      decision: evaluation.decision,
      merged: false,
      reasons: evaluation.reasons,
    }
  }

  const authority = await gw.verifyPolicy?.(pr.headSha)
  if (!authority?.approved || authority.headSha !== pr.headSha) {
    return { headSha: pr.headSha, state: 'security_blocked', decision: 'blocked', merged: false,
      reasons: authority?.reasons.length ? authority.reasons : ['A política independente do motor não foi comprovada para esta revisão.'] }
  }

  // Revalidação anti-TOCTOU imediatamente antes do merge: o HEAD pode ter andado
  // entre a leitura dos checks e agora. Se mudou, NÃO mescla — reavalia no próximo
  // ciclo sobre o novo HEAD.
  const fresh = await gw.getPullRequest(prNumber)
  if (fresh.merged) {
    return { headSha: fresh.headSha, state: 'merged', decision: 'noop', merged: true, reasons: ['PR já mesclada.'] }
  }
  if (fresh.autoMergeEnabled && await gw.disableNativeAutoMerge?.(fresh.nodeId) !== true) {
    return { headSha: fresh.headSha, state: 'security_blocked', decision: 'blocked', merged: false,
      reasons: ['Auto-merge foi reativado durante a validação e não pôde ser desarmado.'] }
  }
  if (fresh.headSha !== pr.headSha) {
    return {
      headSha: fresh.headSha,
      state: 'ci_running',
      decision: 'wait',
      merged: false,
      reasons: ['HEAD mudou logo antes do merge — reavaliar no novo HEAD.'],
    }
  }

  // Merge com o SHA esperado: se o HEAD andar entre isto e o GitHub aplicar, o
  // próprio GitHub recusa (409). Dupla trava.
  await gw.merge(prNumber, pr.headSha)
  return {
    headSha: pr.headSha,
    state: 'merged',
    decision: 'merge',
    merged: true,
    reasons: ['Todos os required checks verdes no HEAD exato — mesclado com SHA esperado.'],
  }
}
