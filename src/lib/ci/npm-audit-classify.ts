/**
 * Classificação de falha do `npm audit --audit-level=high` (gate
 * "Vulnerabilidades" do CI, `.github/workflows/ci.yml`).
 *
 * Já tivemos DUAS falhas reais de infraestrutura do registry do npm
 * deixando PR/main vermelhos sem nenhuma vulnerabilidade real:
 *   - `400 Bad Request — Invalid package tree, run npm install to rebuild
 *     your package-lock.json` no bump para supremo-cli 1.2.6 (o MESMO
 *     lockfile passava no main horas antes — não era o lockfile).
 *   - `503 Service Unavailable` do registry.
 *
 * `npm audit --audit-level=high` continua obrigatório e fail-closed: uma
 * vulnerabilidade real, ou qualquer outro erro genuíno do npm, falha
 * imediatamente, sem retry. Só instabilidade de infraestrutura/rede do
 * registry (usada por `scripts/npm-audit-guard.mts` para decidir retry)
 * é tratada como transitória.
 */

export type AuditFailureClass = 'vulnerability' | 'transient' | 'error'

// Códigos de erro de rede do Node/npm que não têm relação com o código ou o
// lockfile — o processo nunca chegou a completar a requisição ao registry.
const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ESOCKETTIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
])

/**
 * Classifica a saída combinada (stdout+stderr) de uma execução de
 * `npm audit --audit-level=high`.
 *
 * - `'vulnerability'`: o audit RODOU e reportou vulnerabilidade(s) reais no
 *   nível configurado — nenhuma linha `npm error`, é o relatório normal.
 *   Falha imediata, sem retry.
 * - `'transient'`: o npm não conseguiu completar a chamada ao registry por
 *   um motivo de infraestrutura/rede (429, 5xx, timeout, reset, DNS, ou o
 *   400 "Invalid package tree" documentado acima). Elegível a retry.
 * - `'error'`: outro erro real do npm (auth, permissão, 404, EUSAGE etc.).
 *   Retry não ajudaria e mascararia o problema — falha imediata.
 */
export function classifyNpmAuditFailure(output: string): AuditFailureClass {
  // O relatório de vulnerabilidade real do `npm audit` (modo texto, não
  // --json) nunca usa o prefixo "npm error" — só aparece quando o próprio
  // npm falhou em completar a operação (rede, auth, uso incorreto...).
  const hasNpmErrorLine = /npm error /i.test(output)
  if (!hasNpmErrorLine) {
    return 'vulnerability'
  }

  const code = (output.match(/npm error code (\S+)/i)?.[1] ?? '').toUpperCase()

  // Sobrecarga/instabilidade do registry: 429 (rate limit) e qualquer 5xx.
  if (/^E(429|5\d\d)$/.test(code)) {
    return 'transient'
  }

  // Falha de rede/conectividade entre o runner e o registry.
  if (TRANSIENT_NETWORK_CODES.has(code)) {
    return 'transient'
  }
  if (/npm error network/i.test(output)) {
    return 'transient'
  }
  if (/\btimed? ?out\b|\bsocket hang up\b/i.test(output)) {
    return 'transient'
  }

  // Caso real já visto em produção (ver comentário do módulo): o endpoint
  // de audit em lote respondeu 400 "Invalid package tree" por instabilidade
  // do lado do registry, não por lockfile local inconsistente. Neste job,
  // `npm ci` roda ANTES deste passo (ci.yml) e já falha sozinho se a árvore
  // local estiver de fato desalinhada; chegando aqui, essa mensagem só pode
  // vir do registry.
  if (code === 'E400' && /invalid package tree/i.test(output)) {
    return 'transient'
  }

  // Qualquer outro erro do npm (auth, 401/403/404, EUSAGE etc.) é real.
  return 'error'
}
