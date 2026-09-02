import { appAuthConfigured, buildAppJwt } from '@/lib/bootstrap/git-clone-token'
import type { GithubCredentials } from '@/lib/mcp/repository'

/**
 * Credencial server-side da GitHub App para o worker de background (webhook +
 * reconciliation). NUNCA usa o OAuth/sessão do usuário — o merge acontece sem
 * ninguém logado. O installation token é curto (~1h) e escopado à installation.
 * Nunca logamos o token.
 */

const GITHUB_API = 'https://api.github.com'

export function githubAppConfigured(): boolean {
  return appAuthConfigured()
}

/**
 * Emite um installation access token (server-side, curta duração) para a
 * installation dada. Não passamos override de permissões: o token herda o que a
 * App tem GRANTED na installation (pedir permissão não concedida daria 422).
 * O relatório lista o conjunto mínimo a conceder.
 */
export async function appInstallationToken(installationId: number): Promise<string> {
  if (!appAuthConfigured()) {
    throw new Error('GitHub App não configurada (GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY).')
  }
  const jwt = buildAppJwt(
    process.env.GITHUB_APP_ID!,
    process.env.GITHUB_APP_PRIVATE_KEY!,
  )
  const res = await fetch(
    `${GITHUB_API}/app/installations/${installationId}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(20_000),
    },
  )
  if (!res.ok) {
    throw new Error(`Falha ao emitir installation token (${res.status}).`)
  }
  const data = (await res.json()) as { token: string }
  return data.token
}

/**
 * Installation token para um REPO (o fallback periódico não recebe installation
 * id do webhook): App JWT → descobre a installation do repo → emite o token.
 */
export async function appTokenForRepo(repoFullName: string): Promise<string> {
  if (!appAuthConfigured()) {
    throw new Error('GitHub App não configurada.')
  }
  const jwt = buildAppJwt(
    process.env.GITHUB_APP_ID!,
    process.env.GITHUB_APP_PRIVATE_KEY!,
  )
  const inst = await fetch(`${GITHUB_API}/repos/${repoFullName}/installation`, {
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(20_000),
  })
  if (!inst.ok) throw new Error(`Installation do repo não encontrada (${inst.status}).`)
  const { id } = (await inst.json()) as { id: number }
  return appInstallationToken(id)
}

export interface AppInstallation {
  id: number
  accountLogin: string
  accountType: string // 'User' | 'Organization'
}

/** Lista TODAS as installations da App (App JWT). Base da descoberta on-demand. */
export async function listAppInstallations(): Promise<AppInstallation[]> {
  if (!appAuthConfigured()) throw new Error('GitHub App não configurada.')
  const jwt = buildAppJwt(
    process.env.GITHUB_APP_ID!,
    process.env.GITHUB_APP_PRIVATE_KEY!,
  )
  const res = await fetch(`${GITHUB_API}/app/installations?per_page=100`, {
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) throw new Error(`Falha ao listar installations (${res.status}).`)
  const data = (await res.json()) as Array<{
    id: number
    account: { login: string; type: string } | null
  }>
  return data
    .filter((i) => i.account)
    .map((i) => ({
      id: i.id,
      accountLogin: i.account!.login,
      accountType: i.account!.type,
    }))
}

/**
 * Descobre a installation da App para uma conta/org (ex.: "Hijaziia") — SEM
 * depender de persistência. É o resolvedor que o provisioning usa para pegar o
 * installation token server-side do owner escolhido. Case-insensitive.
 */
export async function findInstallationForAccount(
  login: string,
): Promise<AppInstallation | null> {
  return matchInstallation(await listAppInstallations(), login)
}

/** Match puro (case-insensitive) de installation por conta — testável sem I/O. */
export function matchInstallation(
  installations: readonly AppInstallation[],
  login: string,
): AppInstallation | null {
  const target = login.toLowerCase()
  return installations.find((i) => i.accountLogin.toLowerCase() === target) ?? null
}

/**
 * Interpreta o callback do Setup URL da GitHub App (puro). O GitHub redireciona
 * para cá após instalar/atualizar a App com `?installation_id=&setup_action=`.
 * Decide para onde redirecionar — sem 404. `install`/`update` com id → sucesso.
 */
export function interpretSetupCallback(input: {
  installationId: string | null
  setupAction: string | null
  hasUser: boolean
}): { redirect: string } {
  if (!input.hasUser) return { redirect: '/login' }
  const id = Number(input.installationId)
  if (!input.installationId || !Number.isFinite(id) || id <= 0) {
    return { redirect: '/accounts?error=github_app_no_installation' }
  }
  if (input.setupAction === 'request') {
    // Instalação pediu aprovação de um admin da org — ainda não ativa.
    return { redirect: '/accounts?info=github_app_pending_approval' }
  }
  return { redirect: '/accounts?success=github_app_installed' }
}

/** Monta GithubCredentials para o worker a partir de um installation token. */
export function installationCreds(
  token: string,
  repoFullName: string,
  defaultBranch = 'main',
): GithubCredentials {
  const [owner, repo] = repoFullName.split('/')
  if (!owner || !repo) throw new Error(`repo inválido: ${repoFullName}`)
  return { token, repoFullName, owner, repo, branch: defaultBranch, defaultBranch }
}
