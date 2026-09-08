import { requiredGates } from '@/lib/templates/project-files'
import {
  reconcileMerge,
  type MergeGateway,
  type ReconcileResult,
} from './merge-controller'
import type { IntegrationState, MergeMode } from './merge-policy'
import { isSupremoIntegrationRef } from './webhook'

/**
 * Caminho ÚNICO de reconciliation da v3. TANTO o webhook (event-driven) QUANTO o
 * fallback periódico chamam ESTE módulo — não há uma segunda lógica de decisão de
 * merge. A decisão final é sempre `reconcileMerge` (relê PR + HEAD + checks reais).
 */

/** Estados que valem reconciliar (o fallback só olha estes — não varre tudo). */
export const RECONCILABLE_STATES: readonly IntegrationState[] = [
  'ci_running',
  'merge_pending',
  'validated',
  // Failed runs still need durable diagnostics and can be rerun while the
  // workspace is offline. Capture failures must not fall out of the sweep.
  'ci_failed',
  'security_blocked',
]

export function isReconcilable(state: IntegrationState | string | null | undefined): boolean {
  return state != null && (RECONCILABLE_STATES as readonly string[]).includes(state)
}

/**
 * Filtra, para o fallback periódico, só os projetos que precisam de reconciliation:
 * têm uma PR de desenvolvimento aberta E estão num estado relevante. Evita
 * reprocessar tudo indiscriminadamente (seção 3/15).
 */
export function selectReconcilable<
  T extends { integration_state?: string | null; pr_number?: number | null },
>(projects: readonly T[]): T[] {
  return projects.filter(
    (p) => p.pr_number != null && isReconcilable(p.integration_state ?? null),
  )
}

/**
 * Required gates REAIS do projeto — mesma fonte da CI do template (`requiredGates`),
 * nunca uma lista hardcoded frágil. Sem sinal claro, assume o conjunto COMPLETO
 * (fail-safe estrito): melhor exigir demais do que liberar de menos.
 */
export function resolveRequiredChecks(input: {
  fastMode?: boolean | null
  rlsMode?: 'block' | 'warn' | null
}): string[] {
  return requiredGates(input.fastMode ?? false, input.rlsMode ?? 'block')
}

export interface ReconcileLogger {
  /** Observabilidade: NUNCA logar token/secret. Só ids/estados/SHAs curtos. */
  event(name: string, data?: Record<string, unknown>): void
}

/**
 * (PURA) Deriva o novo status do CHECKPOINT a partir do resultado de
 * reconciliação da PR a que ele pertence.
 *
 * BUG REAL (E2E): a reconciliação sempre gravou `integration_state` no
 * PROJETO (`writeIntegrationMeta`, nos dois call sites — webhook e
 * fallback), mas nada gravava de volta no CHECKPOINT: `integration_status`
 * era escrito UMA vez no publish ('ci_running') e nunca mais tocado. O
 * projeto reconciliava corretamente para 'merged' (mostrando "tudo verde"),
 * mas o card do checkpoint no Histórico ficava preso em "Testando" para
 * sempre — mesmo depois de um merge válido.
 *
 * `pushStatus` só avança para 'integrated' quando o merge de fato aconteceu
 * (`result.merged`) — nunca antecipa (fail-closed: sem merge confirmado,
 * `null` e o adapter de persistência não toca push_status). `integrationStatus`
 * sempre reflete o estado técnico mais recente — o MESMO valor que o
 * projeto grava em `integration_state` — para o Histórico nunca divergir do
 * que o projeto já sabe.
 */
export function checkpointStatusFromReconcile(result: {
  state: IntegrationState
  merged: boolean
}): { pushStatus: 'integrated' | null; integrationStatus: IntegrationState } {
  return {
    pushStatus: result.merged ? 'integrated' : null,
    integrationStatus: result.state,
  }
}

/**
 * Reconcilia UMA PR. É o que o webhook e o fallback chamam depois de RELER o estado
 * (o gateway já fala com o GitHub via installation token server-side). O
 * `headShaHint` do webhook NÃO entra aqui — a autorização vem só do gateway.
 */
export async function reconcileProjectPr(input: {
  gateway: MergeGateway
  prNumber: number
  requiredChecks: readonly string[]
  mode: MergeMode
  log?: ReconcileLogger
}): Promise<ReconcileResult> {
  const { gateway, prNumber, requiredChecks, mode, log } = input
  log?.event('reconciliation_started', { prNumber, mode })
  const result = await reconcileMerge(gateway, { prNumber, requiredChecks, mode })
  log?.event('reconciliation_result', {
    prNumber,
    state: result.state,
    decision: result.decision,
    merged: result.merged,
  })
  return result
}

// ── Cleanup de integration branch pós-merge (v3-13) ─────────────────────────

export interface BranchCleanupOutcome {
  /** Chegou a checar se devia apagar (mesmo que a resposta tenha sido "não"). */
  attempted: boolean
  deleted: boolean
  /** null só quando nem deu pra saber a branch (erro na releitura da PR). */
  branch: string | null
  reason: string
}

/**
 * Decisão PURA: esta branch pode ser candidata a cleanup automático?
 *   - reaproveita `isSupremoIntegrationRef` (webhook.ts) — o MESMO namespace
 *     `supremo/` que já é a fronteira de autoridade pra disparar reconciliação;
 *     nunca uma heurística nova/paralela;
 *   - defesa explícita adicional: NUNCA a `defaultBranch` (mesmo que, por
 *     algum bug, uma PR aparecesse com head == main — o que o GitHub já
 *     impede sozinho, mas "nunca excluir main" é regra obrigatória demais
 *     pra depender só de um efeito colateral do namespace).
 */
export function isManagedIntegrationBranch(branch: string, defaultBranch: string): boolean {
  return isSupremoIntegrationRef(branch) && branch !== defaultBranch
}

/**
 * GitHub ref deletion has no compare-and-swap precondition. Even a fresh PR
 * and ref read can race a checkpoint publication, so preserve managed refs.
 * A future garbage collector requires an atomic publication/deletion protocol.
 */
export async function cleanupIntegrationBranchIfMerged(
  gateway: MergeGateway,
  input: { prNumber: number; defaultBranch: string },
  log?: ReconcileLogger,
): Promise<BranchCleanupOutcome> {
  try {
    const pr = await gateway.getPullRequest(input.prNumber)
    if (!pr.merged) {
      return {
        attempted: false,
        deleted: false,
        branch: pr.headRef,
        reason: 'PR não confirmada como mesclada nesta releitura — branch preservada.',
      }
    }
    if (!isManagedIntegrationBranch(pr.headRef, input.defaultBranch)) {
      return {
        attempted: false,
        deleted: false,
        branch: pr.headRef,
        reason: 'Fora do namespace supremo/ (ou é a branch padrão) — nunca tocada.',
      }
    }
    log?.event('integration_branch_preserved', { prNumber: input.prNumber, branch: pr.headRef })
    return {
      attempted: true,
      deleted: false,
      branch: pr.headRef,
      reason: 'Branch preservada: exclusão remota não permite proteger publicações concorrentes.',
    }
  } catch (error) {
    log?.event('integration_branch_cleanup_error', {
      prNumber: input.prNumber,
      message: error instanceof Error ? error.message : 'erro',
    })
    // Nunca lança: o merge/checkpoint já foram persistidos por quem chamou;
    // o próximo reconcile (webhook ou fallback) tenta o cleanup de novo.
    return {
      attempted: true,
      deleted: false,
      branch: null,
      reason: 'Erro ao consultar/apagar — será tentado de novo na próxima reconciliação.',
    }
  }
}
