import { listAppInstallations, matchInstallation, type AppInstallation } from './app'

/**
 * Seleção SEGURA de owner (Supremo v3, seção 1).
 *
 * O owner onde o repo será criado só pode ser oferecido/aceito se for a INTERSEÇÃO:
 *
 *   owners a que o USUÁRIO autenticado tem acesso   (provado pelo token DELE)
 *   ∩
 *   installations da GitHub App Supremo             (onde a App está instalada)
 *
 * NUNCA usar `/app/installations` sozinho: ele é global da App, não autoriza o
 * usuário atual. Um usuário jamais pode escolher uma org à qual só outro tem acesso.
 */

export type OwnerType = 'personal' | 'organization'

export interface Owner {
  login: string
  type: OwnerType
}

/**
 * (PURO) Resolve os owners selecionáveis pela interseção segura.
 *  - conta pessoal: sempre (usa o OAuth do próprio usuário — não exige App);
 *  - organização: só se o USUÁRIO é membro (userOrgLogins, vindo do token dele) E
 *    a App está instalada nela (appInstallations). "Acessível mas sem App" NÃO entra.
 */
export function resolveSelectableOwners(input: {
  userLogin: string
  userOrgLogins: readonly string[]
  appInstallations: readonly AppInstallation[]
}): Owner[] {
  const owners: Owner[] = []
  if (input.userLogin) owners.push({ login: input.userLogin, type: 'personal' })

  for (const org of input.userOrgLogins) {
    if (matchInstallation(input.appInstallations, org)) {
      owners.push({ login: org, type: 'organization' })
    }
  }

  const seen = new Set<string>()
  return owners.filter((o) => {
    const key = o.login.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * (PURO) Autorização anti-forja: o owner escolhido PRECISA estar no conjunto
 * selecionável recalculado no servidor. Bloqueia forjar um owner no request.
 */
export function isOwnerAllowed(owners: readonly Owner[], login: string): boolean {
  const target = login.toLowerCase()
  return owners.some((o) => o.login.toLowerCase() === target)
}

export function ownerTypeOf(owners: readonly Owner[], login: string): OwnerType | null {
  const target = login.toLowerCase()
  return owners.find((o) => o.login.toLowerCase() === target)?.type ?? null
}

/**
 * (PURO) Plano de criação do repo por tipo de owner:
 *  - organização → POST /orgs/{org}/repos com installation token da org (server-side);
 *  - pessoal → POST /user/repos com o OAuth do usuário (fluxo atual, preservado).
 */
export function repoCreationPlan(owner: Owner): {
  endpoint: string
  tokenSource: 'user_oauth' | 'org_installation'
} {
  return owner.type === 'organization'
    ? { endpoint: `/orgs/${owner.login}/repos`, tokenSource: 'org_installation' }
    : { endpoint: '/user/repos', tokenSource: 'user_oauth' }
}

// ── I/O (server-side) ────────────────────────────────────────────────────────

interface GithubAccountRow {
  login: string
  access_token_encrypted: string
}

/**
 * Busca os owners selecionáveis para o usuário: lê o login pessoal + as orgs do
 * usuário (com o TOKEN DELE, prova de acesso) e cruza com as installations da App.
 * Falhas de rede degradam com segurança (só a conta pessoal, ou vazio).
 */
export interface SelectableOwnersResult {
  owners: Owner[]
  /**
   * false = a descoberta de installations da GitHub App falhou (App não
   * configurada — GITHUB_APP_ID/PRIVATE_KEY ausentes — ou erro). Nesse caso NÃO
   * dá para resolver organizações; sinalizamos em vez de fingir "só pessoal".
   */
  appAvailable: boolean
  /** Quantas orgs o token do usuário listou (para diagnóstico honesto). */
  userOrgCount: number
}

export async function getSelectableOwners(
  userOauthToken: string,
  userLogin: string,
): Promise<SelectableOwnersResult> {
  let userOrgLogins: string[] = []
  try {
    const res = await fetch('https://api.github.com/user/orgs?per_page=100', {
      headers: {
        Authorization: `Bearer ${userOauthToken}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(15_000),
    })
    if (res.ok) {
      const orgs = (await res.json()) as Array<{ login: string }>
      userOrgLogins = orgs.map((o) => o.login)
    }
  } catch {
    userOrgLogins = []
  }

  // Installations da App. Se FALHAR (App não configurada/erro), NÃO caímos em
  // silêncio para "só pessoal": marcamos appAvailable=false para a UI avisar.
  let appInstallations: AppInstallation[] = []
  let appAvailable = true
  try {
    appInstallations = await listAppInstallations()
  } catch {
    appAvailable = false
  }

  return {
    owners: resolveSelectableOwners({ userLogin, userOrgLogins, appInstallations }),
    appAvailable,
    userOrgCount: userOrgLogins.length,
  }
}

export type { GithubAccountRow }
