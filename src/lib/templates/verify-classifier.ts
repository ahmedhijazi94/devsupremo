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
 */
export function classifyRisk(
  changedPaths: readonly string[],
  capabilities: readonly CapabilityId[] = [],
): RiskResult {
  const applicable = securityChecksFor(capabilities)
  const changed = changedPaths.length

  if (changed === 0) {
    return { level: 'quick', checks: [], reason: 'Nada alterado.', changed: 0 }
  }

  const hasFull = changedPaths.some((p) => matchesAny(p, FULL_PATTERNS))
  const hasSecurity = changedPaths.some((p) => matchesAny(p, SECURITY_PATTERNS))
  const allCosmetic = changedPaths.every((p) => matchesAny(p, QUICK_PATTERNS))

  if (hasFull || changed > BROAD_FILE_COUNT) {
    return {
      level: 'full',
      checks: applicable,
      reason: hasFull
        ? 'Arquivo de arquitetura/build/config alterado.'
        : `Mudança ampla (${changed} arquivos).`,
      changed,
    }
  }

  if (hasSecurity) {
    return {
      level: 'security',
      checks: applicable,
      reason: 'Área sensível à segurança alterada.',
      changed,
    }
  }

  if (allCosmetic) {
    return {
      level: 'quick',
      checks: [],
      reason: 'Só alterações cosméticas (UI/CSS/assets).',
      changed,
    }
  }

  // Código comum (ex.: lib/ util): QUICK já cobre (typecheck + lint + testes
  // afetados + scan estático de secret).
  return {
    level: 'quick',
    checks: [],
    reason: 'Alteração de código de baixo risco.',
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
