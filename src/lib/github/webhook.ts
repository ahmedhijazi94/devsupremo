import crypto from 'node:crypto'

/**
 * Webhook da GitHub App — o GATILHO do Merge Controller v3 (event-driven).
 *
 * PRINCÍPIO: o webhook só ACORDA a reconciliation. Ele NUNCA é a autoridade do
 * merge. Nada do payload (SHA, conclusão de check, "mergeable") é usado como
 * autorização — a decisão vem SEMPRE da releitura de PR + HEAD + checks reais no
 * `reconcileMerge`. Assim, evento duplicado, fora de ordem ou reentregue é seguro.
 */

/**
 * Verifica a assinatura HMAC-SHA256 do GitHub (header `X-Hub-Signature-256`).
 * Comparação em tempo constante. Rejeita ausência/formato inválido/secret vazio.
 */
export function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string | null | undefined,
  secret: string,
): boolean {
  if (!secret || !signatureHeader) return false
  if (!signatureHeader.startsWith('sha256=')) return false

  const expected =
    'sha256=' + crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')

  const a = Buffer.from(signatureHeader)
  const b = Buffer.from(expected)
  // timingSafeEqual exige o mesmo tamanho; tamanhos diferentes = já é inválido.
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

/** O que a reconciliation precisa saber para reler o estado real do GitHub. */
export interface WebhookReconcileTarget {
  repoFullName: string
  installationId: number
  /** PRs a reconciliar. Vazio = evento sem PR associada (ignorar). */
  prNumbers: number[]
  /** Só para AUDITORIA/dedupe — NUNCA para autorizar merge. */
  headShaHint: string | null
  event: string
  action: string | null
  deliveryId: string | null
}

type Json = Record<string, unknown>

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}
function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}
function prNumbersFrom(list: unknown): number[] {
  if (!Array.isArray(list)) return []
  return list
    .map((pr) => num((pr as Json)?.number))
    .filter((n): n is number => n !== null)
}

/**
 * Decide se um evento dispara reconciliation e extrai o alvo. Devolve null para
 * eventos/ações irrelevantes (nada a fazer). Eventos considerados:
 *   • pull_request: opened/reopened/synchronize/ready_for_review → reconciliar a PR;
 *   • check_suite / check_run (completed) → reconciliar as PRs associadas.
 *
 * NÃO usamos `workflow_run`: os jobs da CI aparecem como check-runs, então o fim da
 * CI já chega por check_suite/check_run — e `workflow_run` exigiria `Actions: read`
 * sem trazer gatilho novo. Least privilege: só `Checks: read` + `Pull requests`.
 * Não confia em nada além dos IDENTIFICADORES (repo/installation/prNumber); o
 * SHA/conclusão do payload é só dica de auditoria. Evento perdido → o Vercel Cron
 * (fallback) recupera.
 */
export function parseWebhookForReconcile(
  event: string,
  payload: Json,
  deliveryId?: string | null,
): WebhookReconcileTarget | null {
  const installationId = num((payload.installation as Json)?.id)
  const repoFullName = str((payload.repository as Json)?.full_name)
  if (installationId === null || !repoFullName) return null

  const action = str(payload.action)
  const base = {
    repoFullName,
    installationId,
    event,
    action,
    deliveryId: deliveryId ?? null,
  }

  if (event === 'pull_request') {
    const relevant = ['opened', 'reopened', 'synchronize', 'ready_for_review']
    if (!action || !relevant.includes(action)) return null
    const pr = payload.pull_request as Json | undefined
    const prNumber = num(pr?.number)
    if (prNumber === null) return null
    return {
      ...base,
      prNumbers: [prNumber],
      headShaHint: str((pr?.head as Json)?.sha),
    }
  }

  if (event === 'check_suite' || event === 'check_run') {
    if (action !== 'completed') return null
    const suite =
      event === 'check_suite'
        ? (payload.check_suite as Json)
        : ((payload.check_run as Json)?.check_suite as Json)
    const prNumbers = prNumbersFrom(suite?.pull_requests)
    if (prNumbers.length === 0) return null
    return { ...base, prNumbers, headShaHint: str(suite?.head_sha) }
  }

  // workflow_run NÃO é tratado de propósito (exigiria Actions:read sem trazer
  // gatilho novo — ver comentário acima).
  return null
}
