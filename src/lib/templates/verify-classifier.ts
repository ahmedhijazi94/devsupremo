import type { CapabilityId, SecurityCheck } from '@/lib/capabilities'
import { securityChecksFor } from '@/lib/capabilities'

/**
 * Classificador de risco do `npm run verify` — a fonte ÚNICA das regras.
 *
 * A lógica vive aqui (pura, testada) e o `scripts/verify.mjs` gerado é emitido
 * a partir das MESMAS regras (serializando os RegExp), pra nunca haver drift
 * entre o que o Supremo testa e o que roda na máquina do dev.
 *
 * Três níveis:
 *   QUICK    — baixo risco (UI/CSS/texto/util isolado). Segundos.
 *   SECURITY — mexeu em banco/RLS/auth/API/tenant/roles/secrets/… Local aquecido.
 *   FULL     — mudança grande/arquitetural/incerta/release. Suíte completa.
 *
 * Conservador: na dúvida, SOBE de nível, nunca desce.
 */
export type VerifyLevel = 'quick' | 'security' | 'full'

/** Caminhos que forçam FULL (arquitetura/build/config). */
export const FULL_PATTERNS: RegExp[] = [
  /(^|\/)package\.json$/,
  /(^|\/)package-lock\.json$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)yarn\.lock$/,
  /(^|\/)tsconfig[^/]*\.json$/,
  /(^|\/)next\.config\.[cm]?[jt]s$/,
  /(^|\/)vitest\.config\.[cm]?[jt]s$/,
  /(^|\/)playwright\.config\.[cm]?[jt]s$/,
  /(^|\/)eslint\.config\.[cm]?[jt]s$/,
  /(^|\/)\.github\/workflows\//,
]

/** Caminhos sensíveis à segurança → pelo menos SECURITY. */
export const SECURITY_PATTERNS: RegExp[] = [
  /(^|\/)supabase\//,
  /\.sql$/,
  /(^|\/)proxy\.ts$/,
  /(^|\/)middleware\.ts$/,
  /(^|\/)app\/api\//,
  /(^|\/)actions?\//,
  /(^|\/)server\//,
  /rls/i,
  /auth/i,
  /tenant/i,
  /role/i,
  /permission/i,
  /admin/i,
  /storage/i,
  /secret/i,
  /webhook/i,
]

/** Caminhos claramente cosméticos → mantêm QUICK. */
export const QUICK_PATTERNS: RegExp[] = [
  /\.(css|scss|sass|md|mdx|txt|svg|png|jpe?g|webp|gif|ico|woff2?)$/i,
  /(^|\/)components\//,
  /(^|\/)public\//,
]

/** Acima disso, tratamos como mudança ampla → FULL. */
export const BROAD_FILE_COUNT = 25

/**
 * Assinaturas CONHECIDAS e estritas de falha AMBIENTAL do sandbox — nunca um
 * heurístico amplo. Servem só pra decidir se o passo `build` (único passo
 * pesado o bastante pra travar minutos) pode ser DEFERIDO pra CI em vez de
 * travar o checkpoint local. Nenhum outro passo (typecheck/lint/testes/secret
 * scan) é elegível — eles continuam bloqueando sempre, sem exceção.
 *
 * As duas categorias autorizadas pelo Supremo: porta/processo bloqueado pelo
 * sandbox, e rede indisponível pra recurso EXTERNO (DNS/fetch/certificado —
 * não o app tentando falar com um serviço próprio). Erro real de código,
 * TypeScript, bundling, import ou configuração nunca produz estas mensagens
 * — na dúvida, a saída NÃO bate aqui, e o build falha normalmente
 * (fail-closed, exatamente como hoje).
 */
export const ENV_BUILD_FAILURE_PATTERNS: RegExp[] = [
  // Porta/processo já em uso neste sandbox.
  /EADDRINUSE/,
  /address already in use/i,
  // Rede indisponível pra recurso externo (DNS, fetch, pacote, certificado).
  /ENOTFOUND/,
  /EAI_AGAIN/,
  /ENETUNREACH/,
  /getaddrinfo/i,
  /fetch failed/i,
  /network is unreachable/i,
  /unable to get local issuer certificate/i,
]

/**
 * Só o passo `build` (nível FULL) pode consultar isto — ver
 * `ENV_BUILD_FAILURE_PATTERNS`. Casa contra a saída (stdout+stderr) da falha.
 */
export function isKnownEnvironmentalBuildFailure(output: string): boolean {
  return ENV_BUILD_FAILURE_PATTERNS.some((re) => re.test(output))
}

/**
 * Ruído CONHECIDO e transitório do Next.js em `tsconfig.json` (dev server /
 * typed routes reescreve `include` sozinho pra acompanhar os tipos que gera
 * em `.next/` — sem relação nenhuma com o código do usuário). MESMA detecção
 * ESTRUTURAL (JSON-diff, nunca texto/regex sobre o arquivo inteiro) já usada
 * por `isKnownNextTsconfigNoise`/`NEXT_TYPES_GLOB_RE` em
 * `packages/cli/src/restore.ts` (E2E v3-10, salvaguarda do restore) —
 * reproduzida aqui verbatim (os dois pacotes são independentes, sem import
 * cruzado) porque `verify.mjs` v3-11 precisa da MESMA decisão fora do
 * processo do restore. Não é uma heurística nova/paralela: mesmo regex,
 * mesmo algoritmo.
 */
export const NEXT_TSCONFIG_TYPES_GLOB_RE = /^\.?\/?\.next\/(dev\/)?types\/\*\*\/\*\.ts$/

/** Deep-equal estrutural (ordem de chave de objeto não importa; de array importa). */
function deepEqualJson(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((v, i) => deepEqualJson(v, b[i]))
  }
  if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null) {
    const keysA = Object.keys(a)
    const keysB = Object.keys(b)
    if (keysA.length !== keysB.length) return false
    return keysA.every(
      (k) =>
        Object.prototype.hasOwnProperty.call(b, k) &&
        deepEqualJson((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    )
  }
  return false
}

/**
 * true SÓ quando a diferença inteira entre os dois `tsconfig.json` (parseados
 * como JSON — nunca texto/diff bruto, imune a reformatação/vírgula/
 * indentação) está em `include`, e cada entrada que entrou/saiu bate com a
 * assinatura ESTRITA do Next. Qualquer outra diferença — em `include` ou fora
 * dele, ou JSON inválido — não é reconhecida: fail-closed (nunca ignora uma
 * mudança real do usuário em `tsconfig.json`, nunca descarta o arquivo).
 */
export function isKnownNextTsconfigNoise(before: string, after: string): boolean {
  let a: unknown
  let b: unknown
  try {
    a = JSON.parse(before)
    b = JSON.parse(after)
  } catch {
    return false
  }
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return false
  if (Array.isArray(a) || Array.isArray(b)) return false

  const { include: includeA, ...restA } = a as Record<string, unknown>
  const { include: includeB, ...restB } = b as Record<string, unknown>
  if (!Array.isArray(includeA) || !Array.isArray(includeB)) return false
  if (!includeA.every((x) => typeof x === 'string') || !includeB.every((x) => typeof x === 'string')) {
    return false
  }
  if (!deepEqualJson(restA, restB)) return false

  const setA = new Set(includeA as string[])
  const setB = new Set(includeB as string[])
  const added = (includeB as string[]).filter((x) => !setA.has(x))
  const removed = (includeA as string[]).filter((x) => !setB.has(x))
  if (added.length === 0 && removed.length === 0) return false // nada mudou de fato
  return [...added, ...removed].every((entry) => NEXT_TSCONFIG_TYPES_GLOB_RE.test(entry))
}

const matchesAny = (path: string, patterns: RegExp[]): boolean =>
  patterns.some((re) => re.test(path))

export interface RiskResult {
  level: VerifyLevel
  checks: SecurityCheck[]
  reason: string
  changed: number
}

/**
 * Classifica o risco de um conjunto de arquivos alterados, considerando as
 * capabilities do projeto (que definem QUAIS checks de segurança existem).
 *
 * `knownNoisePaths` (v3-11): subconjunto de `changedPaths` que o CHAMADOR já
 * confirmou (via `isKnownNextTsconfigNoise`, comparando conteúdo HEAD×
 * worktree) ser SÓ ruído automático/transitório do Next — hoje só
 * `tsconfig.json` é elegível. Esses paths continuam contados em `changed` e
 * o arquivo NUNCA é descartado do changeset (quem chama decide isso, esta
 * função só classifica risco) — só ficam de fora da decisão de NÍVEL/gate:
 * uma alteração simples não vira FULL só por causa desse ruído. Omitido
 * (padrão `[]`) preserva o comportamento anterior exatamente — `tsconfig.json`
 * sozinho continua FULL sem essa confirmação explícita (fail-closed).
 */
export function classifyRisk(
  changedPaths: readonly string[],
  capabilities: readonly CapabilityId[] = [],
  knownNoisePaths: readonly string[] = [],
): RiskResult {
  const applicable = securityChecksFor(capabilities)
  const changed = changedPaths.length

  if (changed === 0) {
    return { level: 'quick', checks: [], reason: 'Nada alterado.', changed: 0 }
  }

  const noiseSet = new Set(knownNoisePaths.filter((p) => changedPaths.includes(p)))
  const riskPaths = changedPaths.filter((p) => !noiseSet.has(p))
  const noiseSuffix = noiseSet.size > 0 ? ' (tsconfig.json: ruído conhecido do Next, ignorado na classificação)' : ''

  const hasFull = riskPaths.some((p) => matchesAny(p, FULL_PATTERNS))
  const hasSecurity = riskPaths.some((p) => matchesAny(p, SECURITY_PATTERNS))
  const allCosmetic = changedPaths.every((p) => noiseSet.has(p) || matchesAny(p, QUICK_PATTERNS))

  if (hasFull || riskPaths.length > BROAD_FILE_COUNT) {
    return {
      level: 'full',
      checks: applicable,
      reason:
        (hasFull
          ? 'Arquivo de arquitetura/build/config alterado.'
          : `Mudança ampla (${riskPaths.length} arquivos).`) + noiseSuffix,
      changed,
    }
  }

  if (hasSecurity) {
    return {
      level: 'security',
      checks: applicable,
      reason: 'Área sensível à segurança alterada.' + noiseSuffix,
      changed,
    }
  }

  if (allCosmetic) {
    return {
      level: 'quick',
      checks: [],
      reason: 'Só alterações cosméticas (UI/CSS/assets).' + noiseSuffix,
      changed,
    }
  }

  // Código comum (ex.: lib/ util): QUICK já cobre (typecheck + lint + testes
  // afetados + scan estático de secret).
  return {
    level: 'quick',
    checks: [],
    reason: 'Alteração de código de baixo risco.' + noiseSuffix,
    changed,
  }
}

/** Serializa os RegExp pra emitir no verify.mjs sem drift de lógica. */
export function serializePatterns(patterns: RegExp[]): string {
  return (
    '[' +
    patterns
      .map((re) => `new RegExp(${JSON.stringify(re.source)}, ${JSON.stringify(re.flags)})`)
      .join(', ') +
    ']'
  )
}
