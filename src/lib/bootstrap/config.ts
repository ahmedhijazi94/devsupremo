import {
  getGithubCredentials,
  getSupabaseCredentials,
  resolveProject,
  type ProjectRecord,
} from '@/lib/mcp/repository'
import { getSupabaseAnonKey } from '@/lib/preview'
import type { BootstrapScope } from './codes'
import {
  appAuthConfigured,
  buildAppJwt,
  type CloneToken,
} from './git-clone-token'

const GITHUB_API = 'https://api.github.com'

// ── Emissão do installation token (I/O; coberto pelo E2E) ────────────────────

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

/** Installation token repo-scoped (contents:read) para owner/repo. */
async function installationTokenForRepo(
  repoFullName: string,
): Promise<{ token: string; expiresAt: string }> {
  const [owner, repo] = repoFullName.split('/')
  if (!owner || !repo) throw new Error(`repo inválido: ${repoFullName}`)
  const jwt = buildAppJwt(
    process.env.GITHUB_APP_ID!,
    process.env.GITHUB_APP_PRIVATE_KEY!,
  )
  const installation = await ghApp<{ id: number }>(
    `/repos/${owner}/${repo}/installation`,
    jwt,
  )
  const result = await ghApp<{ token: string; expires_at: string }>(
    `/app/installations/${installation.id}/access_tokens`,
    jwt,
    {
      method: 'POST',
      body: JSON.stringify({
        repositories: [repo],
        permissions: { contents: 'read' },
      }),
    },
  )
  return { token: result.token, expiresAt: result.expires_at }
}

/**
 * Resolve o token de clone: installation token repo-scoped se o App estiver
 * configurado; senão, o fallback user-to-server.
 */
async function resolveCloneToken(
  project: ProjectRecord,
  fallback: () => Promise<string>,
): Promise<CloneToken> {
  if (appAuthConfigured() && project.github_repo_full_name) {
    try {
      const { token, expiresAt } = await installationTokenForRepo(
        project.github_repo_full_name,
      )
      return { token, scope: 'installation', expiresAt }
    } catch {
      // App configurado mas falhou (repo sem o App instalado, etc.): fallback.
    }
  }
  return { token: await fallback(), scope: 'user', expiresAt: null }
}

/**
 * Config entregue à máquina local após um resgate de bootstrap válido.
 *
 * PRINCÍPIO DE MENOR PRIVILÉGIO:
 *   • env só com NEXT_PUBLIC_ (públicas por design — vão ao bundle de qualquer
 *     forma). NUNCA service_role aqui.
 *   • gitToken é de curta duração (renovado pelo refresh), só pro clone.
 *   • nada disto entra no Git (o .env.local é gitignored) nem em log.
 */
export interface BootstrapConfig {
  project: {
    id: string
    name: string
    capabilities: string[]
    scaffoldVersion: string | null
    securityProfile: string | null
  }
  repo: { url: string; fullName: string; branch: string }
  /** Token curto só pro clone. Repo-scoped (installation) quando possível. */
  gitToken: string
  /** Origem do token de clone, para observabilidade (sem revelar o valor). */
  gitTokenScope: 'installation' | 'user'
  /** Só variáveis públicas (NEXT_PUBLIC_…). */
  env: Record<string, string>
}

export async function resolveBootstrapConfig(
  scope: BootstrapScope,
): Promise<BootstrapConfig> {
  // resolveProject filtra pelo dono — projeto de outro usuário nem aparece.
  const project = await resolveProject(scope.userId, scope.projectId)
  const gh = await getGithubCredentials(scope.userId, project)

  // Token de clone: installation token repo-scoped se o App estiver configurado;
  // senão, o token user-to-server (fallback). Só entregue pelo canal seguro.
  const clone = await resolveCloneToken(project, async () => gh.token)

  // Env PÚBLICAS do projeto (Supabase URL + anon). Best-effort: sem Supabase
  // vinculado, o app sobe sem elas (e avisa).
  const env: Record<string, string> = {}
  try {
    const supa = await getSupabaseCredentials(scope.userId, project)
    env.NEXT_PUBLIC_SUPABASE_URL = `https://${supa.projectRef}.supabase.co`
    const anon = await getSupabaseAnonKey(supa.token, supa.projectRef)
    if (anon) env.NEXT_PUBLIC_SUPABASE_ANON_KEY = anon
  } catch {
    // projeto sem Supabase: segue sem as env públicas do backend
  }

  const row = project as unknown as Record<string, unknown>
  return {
    project: {
      id: project.id,
      name: project.name,
      capabilities: Array.isArray(row.capabilities)
        ? (row.capabilities as string[])
        : [],
      scaffoldVersion: (row.scaffold_version as string | null) ?? null,
      securityProfile: (row.security_profile as string | null) ?? null,
    },
    repo: {
      url: `https://github.com/${gh.repoFullName}.git`,
      fullName: gh.repoFullName,
      branch: gh.branch,
    },
    gitToken: clone.token,
    gitTokenScope: clone.scope,
    env,
  }
}
