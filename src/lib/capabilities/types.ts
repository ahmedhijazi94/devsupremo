/**
 * Contrato de capability — a base da arquitetura CORE + capabilities.
 *
 * O CORE é a fundação (Next + TS + Git + CI + security engine + test harness).
 * Cada capability é um módulo OPCIONAL que declara só o que precisa: arquivos,
 * dependências, migrations, env vars, checks de segurança e invariantes. Uma
 * capability DESLIGADA não deve deixar rastro nenhum no scaffold (sem tabela,
 * sem env, sem dependência) — isso é testado.
 *
 * Só declaramos aqui o formato. O registry diz quais estão IMPLEMENTADAS; as
 * demais (admin, webhooks, payments, ai, rag) existem como id planejado pra
 * caberem depois SEM reescrever o core.
 */

/** Todas as capabilities que a arquitetura conhece (implementadas ou não). */
export const CAPABILITY_IDS = [
  'auth',
  'multitenant',
  'storage',
  'admin',
  'webhooks',
  'payments',
  'ai',
  'rag',
] as const

export type CapabilityId = (typeof CAPABILITY_IDS)[number]

/**
 * Categorias de verificação que o security engine sabe rodar. O CORE liga
 * `secrets` e `xss` sempre; cada capability liga as suas. `npm run verify`
 * escolhe QUICK/SECURITY/FULL, mas o CONJUNTO aplicável vem daqui.
 */
export const SECURITY_CHECKS = [
  'secrets',
  'xss',
  'rls',
  'authorization',
  'idor',
  'tenant-isolation',
  'storage-policies',
  'migration-safety',
  'webhook-signature',
] as const

export type SecurityCheck = (typeof SECURITY_CHECKS)[number]

/** Perfil de segurança inferido — determina a INTENSIDADE, nunca reduz o básico. */
export const SECURITY_PROFILES = [
  'simple', // pouca superfície privada (CORE only)
  'standard', // auth + dados privados
  'multitenant', // organizations/workspaces/tenants
  'sensitive', // admin, financeiro, permissões críticas, integrações privilegiadas
] as const

export type SecurityProfile = (typeof SECURITY_PROFILES)[number]

/** Uma variável de ambiente que a capability precisa (para o .env.example). */
export interface EnvVarSpec {
  name: string
  description: string
  /** true = NEXT_PUBLIC_ (vai ao bundle). false = server-side (nunca ao front). */
  public: boolean
  /** Se o Supremo consegue preencher no bootstrap automaticamente. */
  autoProvisioned: boolean
}

/**
 * Contrato que cada capability implementada preenche. Tudo além de id/title é
 * opcional — a capability só declara o que realmente contribui.
 */
export interface Capability {
  id: CapabilityId
  title: string
  description: string
  /** Implementada de verdade neste momento? (false = só arquiteturalmente prevista) */
  implemented: boolean
  /** Outras capabilities que esta exige (expandidas automaticamente). */
  dependsOn?: CapabilityId[]
  /** Dependências npm de runtime que a capability adiciona. */
  npmDependencies?: Record<string, string>
  /** Dependências npm de dev que a capability adiciona. */
  npmDevDependencies?: Record<string, string>
  /** Env vars declaradas (só nomes/descrição vão ao repo, nunca valores). */
  envVars?: EnvVarSpec[]
  /** Checks de segurança que esta capability liga. */
  securityChecks?: SecurityCheck[]
  /** Invariantes legíveis (entram no AGENTS.md/SECURITY.md). */
  securityInvariants?: string[]
}
