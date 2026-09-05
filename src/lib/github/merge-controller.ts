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
  }>
  /** Checks do ref dado + o SHA a que pertencem (headSha). */
  getChecks(ref: string): Promise<{ checks: CheckRun[]; headSha: string }>
  allowAutoMerge(): Promise<boolean>
  enableNativeAutoMerge(nodeId: string): Promise<boolean>
  merge(prNumber: number, expectedSha: string): Promise<{ sha: string }>
  /** Apaga uma branch. Silencioso se ela já não existe (idempotente) — ver
   * `github/client.ts#deleteBranch`. Só chamado pelo cleanup pós-merge (v3-13),
   * nunca pela decisão de merge em si. */
  deleteBranch(branch: string): Promise<void>
}

export interface ReconcileResult {
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
    return { state: 'merged', decision: 'noop', merged: true, reasons: ['PR já mesclada.'] }
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
    // Não mexemos se um gate já falhou — o auto-merge nativo simplesmente não
    // dispara enquanto vermelho; habilitar é idempotente e seguro em qualquer caso.
    if (evaluation.decision !== 'blocked') {
      await gw.allowAutoMerge()
      await gw.enableNativeAutoMerge(pr.nodeId)
    }
    return {
      state: evaluation.decision === 'blocked' ? evaluation.state : 'merge_pending',
      decision: evaluation.decision,
      merged: false,
      reasons: [
        'Modo nativo: auto-merge do GitHub cuida do merge quando o HEAD ficar verde.',
        ...evaluation.reasons,
      ],
    }
  }

  // ── SUPREMO_MANAGED: nós validamos e mesclamos ───────────────────────────────
  if (evaluation.decision !== 'merge') {
    return {
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
    return { state: 'merged', decision: 'noop', merged: true, reasons: ['PR já mesclada.'] }
  }
  if (fresh.headSha !== pr.headSha) {
    return {
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
    state: 'merged',
    decision: 'merge',
    merged: true,
    reasons: ['Todos os required checks verdes no HEAD exato — mesclado com SHA esperado.'],
  }
}
