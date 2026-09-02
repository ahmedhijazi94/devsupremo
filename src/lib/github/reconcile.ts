import { requiredGates } from '@/lib/templates/project-files'
import {
  reconcileMerge,
  type MergeGateway,
  type ReconcileResult,
} from './merge-controller'
import type { IntegrationState, MergeMode } from './merge-policy'

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
