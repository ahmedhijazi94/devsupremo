import crypto from 'crypto'
import type { ProjectRecord } from '@/lib/mcp/repository'

/**
 * Token efêmero de clone para o bootstrap.
 *
 * PREFERÊNCIA (least privilege): GitHub App **installation token** repo-scoped e
 * de curta duração (≤1h), emitido só para o repo do projeto. Isso exige a chave
 * privada do App (GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY) no ambiente.
 *
 * FALLBACK: se a chave do App não estiver configurada, usa o token user-to-server
 * do GitHub App (8h, já renovado pelo refresh) que o Supremo guarda. Em ambos os
 * casos o token só é entregue pelo canal seguro do bootstrap e o CLI o usa sem
 * jamais colocá-lo em URL, argv, .git/config, stdout/stderr ou log.
 */
const GITHUB_API = 'https://api.github.com'

export interface CloneToken {
  token: string
  scope: 'installation' | 'user'
  /** ISO; null quando não sabemos (fallback user token). */
  expiresAt: string | null
}

/** Há chave de App para emitir installation token repo-scoped? */
export function appAuthConfigured(): boolean {
  return Boolean(process.env.GITHUB_APP_ID && process.env.GITHUB_APP_PRIVATE_KEY)
}

function normalizePrivateKey(raw: string): string {
  // Vercel/CI costumam guardar a chave com \n literais.
  return raw.includes('\\n') ? raw.replace(/\\n/g, '\n') : raw
}

const b64url = (input: string | Buffer): string =>
  (typeof input === 'string' ? Buffer.from(input) : input).toString('base64url')

/** JWT RS256 do App (curto, ≤10min). Pura e testável. */
export function buildAppJwt(
  appId: string,
  privateKeyPem: string,
  now: number = Date.now(),
): string {
  const iat = Math.floor(now / 1000) - 60 // tolera clock skew
  const header = { alg: 'RS256', typ: 'JWT' }
  const payload = { iat, exp: iat + 600, iss: appId }
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`
  const signature = crypto
    .createSign('RSA-SHA256')
    .update(signingInput)
    .sign(normalizePrivateKey(privateKeyPem))
  return `${signingInput}.${b64url(signature)}`
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
  if (!res.ok) {
    throw new Error(`GitHub App API ${path} → ${res.status}`)
  }
  return (await res.json()) as T
}

/** Emite um installation token repo-scoped (contents:read) para owner/repo. */
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
 * Resolve o token de clone: installation token repo-scoped se possível, senão
 * o fallback (token user-to-server que o chamador fornece).
 */
export async function resolveCloneToken(
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
