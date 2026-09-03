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

/**
 * Namespace EXCLUSIVO das branches de integração que o Supremo publica
 * (ver `INTEGRATION_BRANCH_PREFIX` em `checkpoint/integration.ts`). Nenhum
 * checkpoint, humano ou bot cria PR nesse namespace por fora do Supremo.
 */
const SUPREMO_INTEGRATION_BRANCH_PREFIX = 'supremo/'

/**
 * Só uma PR cujo HEAD está no namespace de integração do Supremo pode disparar
 * reconciliation. SEM isto, o webhook reconcilia QUALQUER PR do repositório —
 * inclusive uma do Dependabot ou de um colaborador externo — e:
 *   (a) sobrescreve o `integration_state` do PROJETO com o resultado de uma PR
 *       que não tem nada a ver com nenhum checkpoint do usuário;
 *   (b) no modo `supremo_managed`, pode MERGEAR essa PR sozinho assim que os
 *       checks dela ficarem verdes — uma escrita não pedida pelo usuário.
 * Filtrar aqui é suficiente e correto: o namespace é a fronteira de autoridade,
 * não uma lista de exceções.
 */
export function isSupremoIntegrationRef(ref: string | null): boolean {
  return ref !== null && ref.startsWith(SUPREMO_INTEGRATION_BRANCH_PREFIX)
}

function prNumbersFrom(list: unknown): number[] {
  if (!Array.isArray(list)) return []
  return list
    .filter((pr) => isSupremoIntegrationRef(str(((pr as Json)?.head as Json)?.ref)))
    .map((pr) => num((pr as Json)?.number))
    .filter((n): n is number => n !== null)
}

/**
 * Decide se um evento dispara reconciliation e extrai o alvo. Devolve null para
 * eventos/ações irrelevantes (nada a fazer). Eventos considerados:
 *   • pull_request: opened/reopened/synchronize/ready_for_review → reconciliar a PR;
 *   • pull_request: closed COM merged:true → reconciliar a PR (ver abaixo);
 *   • check_suite / check_run (completed) → reconciliar as PRs associadas.
 *
 * BUG REAL (E2E — Histórico preso em "Testando" com múltiplos checkpoints na
 * mesma PR): 'closed' nunca esteve na lista de ações relevantes. O projeto só
 * chegava a `integration_state: 'merged'` (READY) por COINCIDÊNCIA de timing
 * — algum check_suite/check_run "completed" disparando reconciliation ENQUANTO
 * a PR ainda estava aberta, no exato momento em que os gates do HEAD ficaram
 * verdes. Sem um gatilho DEDICADO para "a PR realmente mergeou" (o evento
 * 'closed' com `merged: true`, a confirmação MAIS FORTE que o GitHub emite),
 * a reconciliação do checkpoint (que só roda dentro do MESMO ciclo que
 * reconcilia o projeto) fica refém dessa coincidência — e reconciliar o
 * projeto sem reconciliar os checkpoints é sintoma direto de um ciclo de
 * reconciliação que nunca rodou de verdade com `merged: true` confirmado.
 * Fix: 'closed' com `merged: true` agora SEMPRE dispara reconciliation — é o
 * sinal mais confiável e direto de "esta PR mergeou", e `reconcileMerge` já
 * trata `pr.merged` como retorno IMEDIATO (`{ state: 'merged', merged: true }`),
 * então este gatilho por si só já é suficiente pra reconciliar projeto E
 * checkpoints, mesmo que nenhum evento anterior tenha pego o estado a tempo.
 * 'closed' SEM merge (PR fechada/abandonada) continua fora — não há nada pra
 * reconciliar, e tentar mesclar uma PR fechada só geraria um erro inútil.
 *
 * NÃO usamos `workflow_run`: os jobs da CI aparecem como check-runs, então o fim da
 * CI já chega por check_suite/check_run — e `workflow_run` exigiria `Actions: read`
 * sem trazer gatilho novo. Least privilege: só `Checks: read` + `Pull requests`.
 * Não confia em nada além dos IDENTIFICADORES (repo/installation/prNumber); o
 * SHA/conclusão do payload é só dica de auditoria — `merged` decide só se este
 * evento CONTA como gatilho, nunca se o merge é AUTORIZADO (isso é sempre
 * `evaluateMergeEligibility`, relendo os checks reais no HEAD exato). Evento
 * perdido → o Vercel Cron (fallback) recupera enquanto a PR ainda está aberta.
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
    const pr = payload.pull_request as Json | undefined
    const isConfirmedMergeClose = action === 'closed' && pr?.merged === true
    if (!action || (!relevant.includes(action) && !isConfirmedMergeClose)) return null
    const prNumber = num(pr?.number)
    if (prNumber === null) return null
    // Bot/colaborador externo (ex.: Dependabot) abre PR fora do namespace
    // supremo/ o tempo todo — não é um checkpoint, e não deve tocar
    // integration_state nem ser candidata a merge pelo Merge Controller.
    if (!isSupremoIntegrationRef(str((pr?.head as Json)?.ref))) return null
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
