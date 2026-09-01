import { CAPABILITIES } from './registry'
import {
  CAPABILITY_IDS,
  type Capability,
  type CapabilityId,
  type EnvVarSpec,
  type SecurityCheck,
  type SecurityProfile,
} from './types'

export * from './types'
export { CAPABILITIES, IMPLEMENTED_CAPABILITY_IDS } from './registry'

/**
 * Expande dependências, deduplica e valida que tudo pedido está IMPLEMENTADO.
 * Retorna em ordem canônica (a de CAPABILITY_IDS), pra saída determinística.
 *
 * Lança se pedir uma capability desconhecida ou só planejada — o Supremo não
 * promete o que não gera.
 */
export function resolveCapabilities(
  requested: readonly CapabilityId[],
): CapabilityId[] {
  const out = new Set<CapabilityId>()

  const visit = (id: CapabilityId, trail: CapabilityId[]): void => {
    const cap = CAPABILITIES[id]
    if (!cap) throw new Error(`Capability desconhecida: ${id}`)
    if (!cap.implemented) {
      throw new Error(`Capability "${id}" ainda não é implementada.`)
    }
    if (trail.includes(id)) return // ciclo defensivo (não deve acontecer)
    for (const dep of cap.dependsOn ?? []) visit(dep, [...trail, id])
    out.add(id)
  }

  for (const id of requested) visit(id, [])

  return CAPABILITY_IDS.filter((id) => out.has(id))
}

/**
 * Perfil de segurança inferido PRINCIPALMENTE pelas capabilities. Ordem de
 * intensidade: sensitive > multitenant > standard > simple. Determina a
 * INTENSIDADE dos checks — nunca desliga o baseline (secrets/xss/rls c/ auth).
 *
 * O `kind` legado (public/solo/team) entra só como SINAL secundário: serve de
 * piso, nunca sobrepõe uma superfície mais sensível detectada nas capabilities.
 * Capabilities são a fonte; kind é uma dica.
 */
const PROFILE_RANK: Record<SecurityProfile, number> = {
  simple: 0,
  standard: 1,
  multitenant: 2,
  sensitive: 3,
}

export function inferSecurityProfile(
  capabilities: readonly CapabilityId[],
  signals: { kind?: 'public' | 'solo' | 'team' } = {},
): SecurityProfile {
  const has = (id: CapabilityId) => capabilities.includes(id)

  // Fonte primária: as capabilities/arquitetura real.
  let profile: SecurityProfile
  if (has('admin') || has('payments') || has('webhooks')) profile = 'sensitive'
  else if (has('multitenant')) profile = 'multitenant'
  else if (has('auth') || has('storage')) profile = 'standard'
  else profile = 'simple'

  // Sinal secundário: kind como PISO (só sobe, nunca desce o já detectado).
  const floorFromKind: SecurityProfile | null =
    signals.kind === 'team'
      ? 'multitenant'
      : signals.kind === 'solo'
        ? 'standard'
        : null
  if (floorFromKind && PROFILE_RANK[floorFromKind] > PROFILE_RANK[profile]) {
    profile = floorFromKind
  }

  return profile
}

/**
 * Conjunto de checks aplicáveis: baseline do CORE (secrets, xss) + o que cada
 * capability liga. É o universo que o `verify` pode rodar; a suíte QUICK/
 * SECURITY/FULL escolhe um subconjunto por risco.
 */
export function securityChecksFor(
  capabilities: readonly CapabilityId[],
): SecurityCheck[] {
  const set = new Set<SecurityCheck>(['secrets', 'xss']) // CORE baseline, sempre
  for (const id of capabilities) {
    for (const check of CAPABILITIES[id]?.securityChecks ?? []) set.add(check)
  }
  // Mexer em banco sempre pede migration-safety (o CORE já traz Supabase).
  set.add('migration-safety')
  return [...set]
}

/** Env vars declaradas pelas capabilities (deduplicadas por nome). Só nomes/descrição. */
export function collectEnvVars(
  capabilities: readonly CapabilityId[],
): EnvVarSpec[] {
  const byName = new Map<string, EnvVarSpec>()
  for (const id of capabilities) {
    for (const spec of CAPABILITIES[id]?.envVars ?? []) {
      if (!byName.has(spec.name)) byName.set(spec.name, spec)
    }
  }
  return [...byName.values()]
}

/** Invariantes de segurança das capabilities ligadas (pro AGENTS.md/SECURITY.md). */
export function securityInvariantsFor(
  capabilities: readonly CapabilityId[],
): string[] {
  const out: string[] = []
  for (const id of capabilities) {
    for (const inv of CAPABILITIES[id]?.securityInvariants ?? []) {
      if (!out.includes(inv)) out.push(inv)
    }
  }
  return out
}

/**
 * Ponte com o `kind` legado (public/solo/team) enquanto a UI de capabilities
 * não substitui a escolha antiga. Mantém o comportamento atual sem quebrar
 * projetos existentes.
 */
export function capabilitiesForKind(
  kind: 'public' | 'solo' | 'team',
): CapabilityId[] {
  switch (kind) {
    case 'public':
      return [] // só CORE
    case 'solo':
      return resolveCapabilities(['auth'])
    case 'team':
      return resolveCapabilities(['auth', 'multitenant'])
  }
}

export type { Capability }
