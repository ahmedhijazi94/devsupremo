import type { MergeMode, ProtectionLevel } from './merge-policy'

/**
 * Capability detection do repositório (Supremo v3, seção 1).
 *
 * NÃO decidimos por nome de plano (`if plan === 'pro'` é frágil). Decidimos pela
 * CAPACIDADE EFETIVA do repositório + permissões disponíveis: só é `native` quando
 * dá mesmo para (a) proteger a `main` com required checks e (b) usar o auto-merge
 * nativo do GitHub. Senão, cai para `supremo_managed`, onde o Merge Controller do
 * Supremo valida e mescla via API. O plano é só um SINAL.
 */
export interface RepoCapabilitySignals {
  /** O PUT de branch protection funcionou (não 403/404 por plano/permissão). */
  branchProtectionApplied: boolean
  /** O repo aceita/ativou `allow_auto_merge` (auto-merge nativo disponível). */
  autoMergeAvailable: boolean
  /** A App tem permissão para administrar o repo (administration:write). Sinal. */
  canAdminister?: boolean
  /** Dica do plano (Free/Pro/Team/Enterprise) — SÓ sinal, nunca decisão final. */
  planHint?: string | null
}

/**
 * Escolhe o modo de merge pela capacidade real. Fail-safe: na dúvida, escolhe o
 * modo GERENCIADO (nunca assume proteção nativa que não existe — seção 11).
 */
export function chooseMergeMode(signals: RepoCapabilitySignals): MergeMode {
  return signals.branchProtectionApplied && signals.autoMergeAvailable
    ? 'native'
    : 'supremo_managed'
}

/** Nível de proteção REAL do modo — para observabilidade honesta (não mentir na UI). */
export function protectionLevelFor(mode: MergeMode): ProtectionLevel {
  return mode === 'native' ? 'github_native' : 'supremo_managed'
}

/**
 * Uma capacidade pode mudar (upgrade/downgrade de plano, transferência de repo,
 * mudança de permissão da App — seção 13). Reavaliar é seguro e idempotente:
 * recalcula o modo a partir dos sinais atuais. Migrar managed→native FORTALECE;
 * native→managed só DEGRADA a enforcement, nunca deixa merge inseguro (o Merge
 * Controller assume). Devolve o novo modo e se houve mudança.
 */
export function reevaluateMergeMode(
  current: MergeMode | null,
  signals: RepoCapabilitySignals,
): { mode: MergeMode; changed: boolean; direction: 'upgrade' | 'downgrade' | 'same' } {
  const next = chooseMergeMode(signals)
  if (current === next) return { mode: next, changed: false, direction: 'same' }
  const direction =
    current === 'supremo_managed' && next === 'native'
      ? 'upgrade'
      : current === 'native' && next === 'supremo_managed'
        ? 'downgrade'
        : 'same'
  return { mode: next, changed: current !== null, direction }
}
