/**
 * Cliente da API da Vercel.
 *
 * O preview dos projetos deixou de rodar no navegador (WebContainer) e passou
 * a ser deploy real: cada pull request ganha uma URL própria, que sobrevive a
 * fechar a aba e pode ser mandada para outra pessoa. Em troca, o preview leva
 * dezenas de segundos em vez de ser instantâneo.
 */

const API = 'https://api.vercel.com'

export class VercelError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'VercelError'
    this.status = status
  }
}

interface RequestOptions {
  token: string
  teamId?: string | null
  method?: string
  body?: unknown
}

async function call<T>(path: string, options: RequestOptions): Promise<T> {
  const url = new URL(`${API}${path}`)
  if (options.teamId) url.searchParams.set('teamId', options.teamId)

  const response = await fetch(url, {
    method: options.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${options.token}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    cache: 'no-store',
  })

  const text = await response.text()
  const payload: unknown = text ? JSON.parse(text) : {}

  if (!response.ok) {
    const detail =
      (payload as { error?: { message?: string } })?.error?.message ??
      `HTTP ${response.status}`
    throw new VercelError(detail, response.status)
  }

  return payload as T
}

// ─────────────────────────────────────────────────────────────
// Identidade
// ─────────────────────────────────────────────────────────────

export interface VercelIdentity {
  accountName: string
  teamId: string | null
}

/**
 * Valida o token e descobre em que conta ele opera.
 *
 * Um token com escopo de time não enxerga a conta pessoal e vice-versa, por
 * isso o teamId precisa ser descoberto aqui e guardado junto.
 */
export async function identify(token: string): Promise<VercelIdentity> {
  const teams = await call<{ teams?: Array<{ id: string; name: string }> }>(
    '/v2/teams',
    { token }
  )

  const team = teams.teams?.[0]
  if (team) {
    return { accountName: team.name, teamId: team.id }
  }

  const user = await call<{ user: { username: string; name?: string } }>(
    '/v2/user',
    { token }
  )

  return {
    accountName: user.user.name ?? user.user.username,
    teamId: null,
  }
}

/**
 * Descobre o nome da conta a partir de uma instalação de Integration.
 *
 * O token vindo do OAuth já sabe em que conta opera — o teamId chega na
 * resposta da troca do código. Consultar /v2/teams aqui devolveria a lista
 * de times do usuário, não o time da instalação.
 */
export async function identifyInstallation(
  token: string,
  teamId: string | null
): Promise<VercelIdentity> {
  if (teamId) {
    const team = await call<{ name?: string; slug?: string }>(
      `/v2/teams/${teamId}`,
      { token }
    )
    return { accountName: team.name ?? team.slug ?? teamId, teamId }
  }

  const user = await call<{ user: { username: string; name?: string } }>(
    '/v2/user',
    { token }
  )
  return { accountName: user.user.name ?? user.user.username, teamId: null }
}

// ─────────────────────────────────────────────────────────────
// OAuth de Integration
// ─────────────────────────────────────────────────────────────

export interface OAuthConfig {
  clientId: string
  clientSecret: string
  integrationSlug: string
}

/** Lê a configuração do ambiente. Ausente = OAuth desligado. */
export function oauthConfig(): OAuthConfig | null {
  const clientId = process.env.VERCEL_CLIENT_ID
  const clientSecret = process.env.VERCEL_CLIENT_SECRET
  const integrationSlug = process.env.VERCEL_INTEGRATION_SLUG

  if (!clientId || !clientSecret || !integrationSlug) return null
  return { clientId, clientSecret, integrationSlug }
}

export function installationUrl(
  config: OAuthConfig,
  state: string
): string {
  const params = new URLSearchParams({ state })
  return `https://vercel.com/integrations/${config.integrationSlug}/new?${params.toString()}`
}

export interface ExchangedToken {
  accessToken: string
  teamId: string | null
  installationId: string | null
}

export async function exchangeCode(
  config: OAuthConfig,
  code: string,
  redirectUri: string
): Promise<ExchangedToken> {
  const response = await fetch(`${API}/v2/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  })

  const text = await response.text()
  const payload = (text ? JSON.parse(text) : {}) as {
    access_token?: string
    team_id?: string | null
    installation_id?: string
    error?: string
    error_description?: string
  }

  if (!response.ok || !payload.access_token) {
    throw new VercelError(
      payload.error_description ?? payload.error ?? `HTTP ${response.status}`,
      response.status
    )
  }

  return {
    accessToken: payload.access_token,
    teamId: payload.team_id ?? null,
    installationId: payload.installation_id ?? null,
  }
}

// ─────────────────────────────────────────────────────────────
// Projetos
// ─────────────────────────────────────────────────────────────

export interface VercelProject {
  id: string
  name: string
}

/**
 * Cria o projeto na Vercel já ligado ao repositório.
 *
 * A partir daí a própria Vercel publica: cada branch vira preview e a branch
 * principal vira produção. O Supremo não precisa disparar deploy.
 */
export async function createProject(
  token: string,
  teamId: string | null,
  name: string,
  repoFullName: string
): Promise<VercelProject> {
  return call<VercelProject>('/v11/projects', {
    token,
    teamId,
    method: 'POST',
    body: {
      name,
      framework: 'nextjs',
      gitRepository: { type: 'github', repo: repoFullName },
    },
  })
}

/**
 * Contas do GitHub que esta conta Vercel enxerga.
 *
 * A Vercel só cria projeto a partir de repositório que ela consegue ler, e
 * isso depende do app dela estar instalado naquela conta do GitHub — uma
 * autorização entre Vercel e GitHub, que o Supremo não pode conceder.
 * Consultar antes evita descobrir isso só no fim do provisionamento.
 */
export async function accessibleGitNamespaces(
  token: string,
  teamId: string | null
): Promise<string[]> {
  const data = await call<
    Array<{ name?: string; slug?: string; provider?: string }>
  >('/v1/integrations/git-namespaces?provider=github', { token, teamId })

  return (Array.isArray(data) ? data : [])
    .map((namespace) => namespace.slug ?? namespace.name)
    .filter((name): name is string => Boolean(name))
}

export async function findProjectByName(
  token: string,
  teamId: string | null,
  name: string
): Promise<VercelProject | null> {
  try {
    return await call<VercelProject>(`/v9/projects/${name}`, { token, teamId })
  } catch (error) {
    if (error instanceof VercelError && error.status === 404) return null
    throw error
  }
}

export async function setEnvironmentVariables(
  token: string,
  teamId: string | null,
  projectId: string,
  variables: Record<string, string>
): Promise<void> {
  for (const [key, value] of Object.entries(variables)) {
    if (!value) continue

    await call(`/v10/projects/${projectId}/env?upsert=true`, {
      token,
      teamId,
      method: 'POST',
      body: {
        key,
        value,
        // Chaves NEXT_PUBLIC_ chegam ao navegador de qualquer forma; marcar
        // como plain deixa isso explícito em vez de sugerir sigilo.
        type: key.startsWith('NEXT_PUBLIC_') ? 'plain' : 'encrypted',
        target: ['production', 'preview', 'development'],
      },
    })
  }
}

// ─────────────────────────────────────────────────────────────
// Deploys
// ─────────────────────────────────────────────────────────────

export type DeploymentState =
  | 'BUILDING'
  | 'ERROR'
  | 'INITIALIZING'
  | 'QUEUED'
  | 'READY'
  | 'CANCELED'

export interface Deployment {
  id: string
  url: string
  state: DeploymentState
  target: 'production' | 'preview' | null
  branch: string | null
  createdAt: number
  inspectorUrl: string | null
}

interface RawDeployment {
  uid: string
  url: string
  state?: DeploymentState
  readyState?: DeploymentState
  target?: 'production' | 'preview' | null
  created: number
  inspectorUrl?: string
  meta?: { githubCommitRef?: string }
}

export async function listDeployments(
  token: string,
  teamId: string | null,
  projectId: string,
  options: { branch?: string; limit?: number } = {}
): Promise<Deployment[]> {
  const params = new URLSearchParams({
    projectId,
    limit: String(options.limit ?? 10),
  })

  const data = await call<{ deployments?: RawDeployment[] }>(
    `/v6/deployments?${params.toString()}`,
    { token, teamId }
  )

  return (data.deployments ?? [])
    .map((raw) => ({
      id: raw.uid,
      url: raw.url.startsWith('http') ? raw.url : `https://${raw.url}`,
      state: raw.readyState ?? raw.state ?? 'QUEUED',
      target: raw.target ?? null,
      branch: raw.meta?.githubCommitRef ?? null,
      createdAt: raw.created,
      inspectorUrl: raw.inspectorUrl ?? null,
    }))
    .filter((d) => (options.branch ? d.branch === options.branch : true))
}

/** O deploy mais recente de uma branch, pronto ou não. */
export async function latestDeployment(
  token: string,
  teamId: string | null,
  projectId: string,
  branch?: string
): Promise<Deployment | null> {
  const deployments = await listDeployments(token, teamId, projectId, {
    ...(branch ? { branch } : {}),
    limit: 20,
  })

  return deployments[0] ?? null
}

/** Texto curto de estado, para a interface. */
export function describeState(state: DeploymentState): {
  label: string
  tone: 'ok' | 'working' | 'error'
} {
  switch (state) {
    case 'READY':
      return { label: 'No ar', tone: 'ok' }
    case 'ERROR':
      return { label: 'Falhou', tone: 'error' }
    case 'CANCELED':
      return { label: 'Cancelado', tone: 'error' }
    default:
      return { label: 'Publicando', tone: 'working' }
  }
}
