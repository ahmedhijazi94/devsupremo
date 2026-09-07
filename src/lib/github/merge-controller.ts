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
 * - modo NATIVE_GITHUB: habilita o auto-merge nativo e deixa o GitHub mesclar
 *   sozinho quando os required checks do HEAD ficam verdes;
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

  const checks = await gw.getChecks(pr.headSha)
  const evaluation = evaluateMergeEligibility({
    requiredChecks,
    checkRuns: checks.checks,
    prHeadSha: pr.headSha,
    validatedSha: checks.headSha,
  })

  // ── NATIVE_GITHUB: o GitHub é a barreira e o executor do merge ───────────────
  if (mode === 'native') {
    const protectedByGithub = await gw.hasRequiredChecks?.(requiredChecks) ?? false
    if (!protectedByGithub) {
      const withdrawn = !pr.autoMergeEnabled || await gw.disableNativeAutoMerge?.(pr.nodeId) === true
      return {
        headSha: pr.headSha, state: 'security_blocked', decision: 'blocked', merged: false,
        reasons: [withdrawn
          ? 'A proteção nativa não comprova todos os gates obrigatórios; auto-merge desativado ou não habilitado.'
          : 'A proteção nativa não comprova todos os gates e o GitHub não confirmou a desativação do auto-merge. É necessária atenção.'],
      }
    }
    // Never arm a merge while required checks are absent. Stored native mode
    // alone does not prove that today's GitHub protections include every gate.
    if (evaluation.decision !== 'merge') return {
      headSha: pr.headSha, state: evaluation.state, decision: evaluation.decision,
      merged: false, reasons: evaluation.reasons,
    }
    const fresh = await gw.getPullRequest(prNumber)
    if (fresh.merged) return { headSha: fresh.headSha, state: 'merged', decision: 'noop', merged: true, reasons: ['PR já mesclada.'] }
    if (fresh.headSha !== pr.headSha) return {
      headSha: fresh.headSha, state: 'ci_running', decision: 'wait', merged: false,
      reasons: ['HEAD mudou antes de habilitar auto-merge — reavaliar no novo HEAD.'],
    }
    const enabled = await gw.allowAutoMerge() && await gw.enableNativeAutoMerge(pr.nodeId)
    return {
      headSha: pr.headSha, state: enabled ? 'merge_pending' : 'validated',
      decision: enabled ? 'merge' : 'wait', merged: false,
      reasons: enabled
        ? ['Todos os gates do HEAD atual aprovados; auto-merge nativo habilitado.']
        : ['Gates aprovados; GitHub ainda não permitiu habilitar auto-merge.'],
    }
  }

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

  // Revalidação anti-TOCTOU imediatamente antes do merge: o HEAD pode ter andado
  // entre a leitura dos checks e agora. Se mudou, NÃO mescla — reavalia no próximo
  // ciclo sobre o novo HEAD.
  const fresh = await gw.getPullRequest(prNumber)
  if (fresh.merged) {
    return { headSha: fresh.headSha, state: 'merged', decision: 'noop', merged: true, reasons: ['PR já mesclada.'] }
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
