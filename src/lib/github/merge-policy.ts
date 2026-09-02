/**
 * Política de merge da Supremo v3 — o núcleo independente que decide se uma
 * revisão pode entrar na `main`.
 *
 * Regra central inviolável: **código não validado nunca entra na main**. A decisão
 * NUNCA vem de "o agente disse que passou" nem do verify local — vem SÓ dos checks
 * reais do GitHub, para o HEAD SHA exato, com o conjunto COMPLETO de required checks
 * verde.
 *
 * Este módulo é PURO (sem I/O) para ser exaustivamente testável. O Merge Controller
 * e o caminho nativo o consomem; a camada de I/O (github.ts) só coleta os fatos.
 */

/** Como a `main` é integrada, decidido por capability detection do repositório. */
export type MergeMode = 'native' | 'supremo_managed'

/** Nível REAL de proteção — para observabilidade honesta (não mentir na UI). */
export type ProtectionLevel = 'github_native' | 'supremo_managed'

/** Estado do Control Plane para auditoria/diagnóstico/reconciliação. */
export type IntegrationState =
  | 'development'
  | 'ci_running'
  | 'ci_failed'
  | 'security_blocked'
  | 'validated'
  | 'merge_pending'
  | 'merged'
  | 'unmanaged_main_change'

/** Um check-run do GitHub, reduzido ao que a decisão precisa. */
export interface CheckRun {
  name: string
  /** 'queued' | 'in_progress' | 'completed' */
  status: string
  /** 'success' | 'failure' | 'cancelled' | 'timed_out' | 'action_required' | 'skipped' | 'neutral' | 'stale' | null */
  conclusion: string | null
}

export type MergeDecision = 'merge' | 'wait' | 'blocked'

export interface MergeEvaluation {
  decision: MergeDecision
  state: IntegrationState
  reasons: string[]
  /** Required checks que NÃO estão presentes para o HEAD. */
  missing: string[]
  /** Required checks concluídos SEM sucesso (failure/cancelled/timed_out/skipped/…). */
  failing: string[]
  /** Required checks ainda não concluídos. */
  pending: string[]
}

/**
 * Gates cuja falha é CRÍTICA de segurança — bloqueiam e marcam security_blocked,
 * sinalizando ao agente que precisa corrigir ANTES de construir trabalho dependente.
 * (Casam com os nomes de job da CI gerada — ver CI_JOB_NAMES do template.)
 */
export const SECURITY_GATES: readonly string[] = [
  'Políticas RLS',
  'Varredura de segredos',
  'Vulnerabilidades',
]

/** Só ESTA conclusão libera um required check. Tudo o mais bloqueia (seção 4 v3). */
const PASSING_CONCLUSION = 'success'

/**
 * Decide se a revisão pode ser mesclada, seguindo o contrato v3:
 *
 *  1. o HEAD atual da PR precisa ser EXATAMENTE o SHA a que os checks pertencem
 *     (verde de SHA antigo nunca libera SHA novo — anti-TOCTOU);
 *  2. TODOS os required checks esperados precisam estar PRESENTES para esse HEAD;
 *  3. todos precisam ter CONCLUÍDO;
 *  4. todos precisam ter conclusão `success` (missing/failure/cancelled/timed_out/
 *     skipped/action_required/neutral NÃO liberam).
 *
 * Só quando 1–4 valem a decisão é `merge`. Se falta/pending → `wait` (não bloqueia o
 * agente). Se algum concluiu sem sucesso → `blocked`.
 */
export function evaluateMergeEligibility(input: {
  requiredChecks: readonly string[]
  checkRuns: readonly CheckRun[]
  /** HEAD atual da PR, lido AGORA. */
  prHeadSha: string
  /** SHA a que os `checkRuns` pertencem (o headSha devolvido junto dos checks). */
  validatedSha: string
}): MergeEvaluation {
  const { requiredChecks, checkRuns, prHeadSha, validatedSha } = input

  // (1) Anti-corrida: os checks precisam ser do HEAD atual. Se o HEAD andou entre a
  // leitura dos checks e agora, NÃO mergeia — reavalia no novo HEAD.
  if (!prHeadSha || !validatedSha || prHeadSha !== validatedSha) {
    return {
      decision: 'wait',
      state: 'ci_running',
      reasons: [
        `HEAD mudou desde a validação (checks de ${short(validatedSha)}, HEAD atual ${short(prHeadSha)}) — reavaliar no novo HEAD.`,
      ],
      missing: [],
      failing: [],
      pending: [],
    }
  }

  if (requiredChecks.length === 0) {
    // Sem required checks definidos = não sabemos validar = NÃO libera (fail-closed).
    return {
      decision: 'blocked',
      state: 'ci_failed',
      reasons: ['Nenhum required check definido — fail-closed: não é possível validar.'],
      missing: [],
      failing: [],
      pending: [],
    }
  }

  // Índice do MELHOR resultado por nome (o último costuma ser o do re-run atual).
  const byName = new Map<string, CheckRun>()
  for (const run of checkRuns) byName.set(run.name, run)

  const missing: string[] = []
  const failing: string[] = []
  const pending: string[] = []

  for (const required of requiredChecks) {
    const run = byName.get(required)
    if (!run) {
      missing.push(required) // ausência NÃO é sucesso
      continue
    }
    if (run.status !== 'completed') {
      pending.push(required)
      continue
    }
    if (run.conclusion !== PASSING_CONCLUSION) {
      failing.push(required) // skipped/cancelled/failure/timed_out/… não liberam
    }
  }

  if (failing.length > 0) {
    const securityHit = failing.some((c) => SECURITY_GATES.includes(c))
    return {
      decision: 'blocked',
      state: securityHit ? 'security_blocked' : 'ci_failed',
      reasons: [
        `${failing.length} required check(s) sem sucesso: ${failing.join(', ')}.`,
        ...(securityHit
          ? ['Falha CRÍTICA de segurança — corrigir ANTES de construir trabalho dependente.']
          : []),
      ],
      missing,
      failing,
      pending,
    }
  }

  if (missing.length > 0 || pending.length > 0) {
    return {
      decision: 'wait',
      state: 'ci_running',
      reasons: [
        ...(missing.length ? [`Required checks ausentes: ${missing.join(', ')}.`] : []),
        ...(pending.length ? [`Required checks ainda rodando: ${pending.join(', ')}.`] : []),
      ],
      missing,
      failing,
      pending,
    }
  }

  return {
    decision: 'merge',
    state: 'validated',
    reasons: ['Todos os required checks do HEAD atual concluíram com sucesso.'],
    missing: [],
    failing: [],
    pending: [],
  }
}

function short(sha: string): string {
  return sha ? sha.slice(0, 7) : '(vazio)'
}
