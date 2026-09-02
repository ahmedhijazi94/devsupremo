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

// ── Token de PUSH escopado (checkpoint daemon, v3.1 item 4) ──────────────────

/** Permissões mínimas do token entregue ao daemon. Nunca inclui merge/PR/admin. */
export interface RepoScopedPermissions {
  contents: 'write'
  workflows?: 'write'
}

export interface RepoScopedToken {
  token: string
  repositoryId: number
  installationId: number
  expiresAt: string
}

async function ghApp<T>(path: string, jwt: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${GITHUB_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init?.headers ?? {}),
    },
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) throw new Error(`GitHub App API ${path} → ${res.status}`)
  return (await res.json()) as T
}

/**
 * Emite um installation token ESCOPADO AO REPO EXATO do projeto, com as
 * permissões mínimas (contents:write; +workflows:write só quando o diff mexe em
 * workflows). Preferimos `repository_ids` (id exato) quando ele é conhecido;
 * senão, `repositories:[nome]` — ambos restringem ao repo do projeto (o GitHub
 * recusa cross-repo). NUNCA persistimos nem logamos o token. Curta duração (~1h);
 * o daemon o descarta/revoga logo após o push (`revokeInstallationToken`).
 */
export async function mintRepoScopedToken(input: {
  repoFullName: string
  permissions: RepoScopedPermissions
  repositoryId?: number | null
}): Promise<RepoScopedToken> {
  if (!appAuthConfigured()) throw new Error('GitHub App não configurada.')
  const jwt = buildAppJwt(
    process.env.GITHUB_APP_ID!,
    process.env.GITHUB_APP_PRIVATE_KEY!,
  )
  const installation = await ghApp<{ id: number }>(
    `/repos/${input.repoFullName}/installation`,
    jwt,
  )
  const scope =
    input.repositoryId && input.repositoryId > 0
      ? { repository_ids: [input.repositoryId] }
      : { repositories: [input.repoFullName.split('/')[1]] }
  const result = await ghApp<{ token: string; expires_at: string }>(
    `/app/installations/${installation.id}/access_tokens`,
    jwt,
    {
      method: 'POST',
      body: JSON.stringify({ ...scope, permissions: input.permissions }),
    },
  )
  // Resolve o repository_id (para auditoria/backfill) com o PRÓPRIO token escopado.
  let repositoryId = input.repositoryId ?? 0
  if (!repositoryId) {
    try {
      const repo = await fetch(`${GITHUB_API}/repos/${input.repoFullName}`, {
        headers: {
          Authorization: `Bearer ${result.token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: AbortSignal.timeout(20_000),
      })
      if (repo.ok) repositoryId = ((await repo.json()) as { id: number }).id
    } catch {
      // best-effort: o escopo por nome já garante o repo exato
    }
  }
  return {
    token: result.token,
    repositoryId,
    installationId: installation.id,
    expiresAt: result.expires_at,
  }
}

/**
 * Revoga IMEDIATAMENTE um installation token (o próprio token se auto-revoga via
 * DELETE /installation/token). Best-effort: mesmo que falhe, o token expira em
 * ~1h; o objetivo é reduzir a janela ao mínimo assim que o push termina.
 */
export async function revokeInstallationToken(token: string): Promise<boolean> {
  try {
    const res = await fetch(`${GITHUB_API}/installation/token`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(15_000),
    })
    return res.status === 204
  } catch {
    return false
  }
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
