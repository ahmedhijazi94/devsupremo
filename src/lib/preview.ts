import {
  createDetachedProject,
  deployFiles,
  findProjectByName,
  makePubliclyAccessible,
  deleteProject as deleteVercelProject,
  deploymentLogs,
  extractBuildFailure,
  latestDeployment,
  setEnvironmentVariables,
  VercelError,
  type Deployment,
  type DeployFile,
} from '@/lib/vercel'

/**
 * Preview compartilhado.
 *
 * Os previews de todos os projetos são publicados numa única conta Vercel —
 * a do Supremo — com os arquivos enviados por ele. Isso remove duas
 * autorizações do caminho de quem usa: conectar uma conta Vercel e instalar
 * o app dela em cada conta do GitHub. Sobram GitHub e Supabase.
 *
 * O que isso custa: o build acontece na conta do Supremo e consome a cota
 * dela. No plano gratuito da Vercel só há um build por vez, então com vários
 * projetos publicando ao mesmo tempo a fila aparece. É o momento de subir de
 * plano, não de mudar de arquitetura.
 *
 * Produção continua na conta do usuário: preview é descartável, o site no ar
 * com domínio e dados reais é dele.
 */

export interface SharedPreviewConfig {
  token: string
  teamId: string | null
}

/** Ausente = preview compartilhado desligado; cai na conta do usuário. */
export function sharedPreviewConfig(): SharedPreviewConfig | null {
  const token = process.env.SUPREMO_PREVIEW_VERCEL_TOKEN
  if (!token) return null

  return {
    token,
    teamId: process.env.SUPREMO_PREVIEW_VERCEL_TEAM_ID ?? null,
  }
}

/**
 * Nome do projeto na conta compartilhada.
 *
 * A Vercel limita o nome a 100 caracteres e aceita minúsculas, números e
 * hífen. O id do projeto entra truncado para o nome continuar reconhecível
 * e ainda assim único.
 */
export function previewProjectName(
  projectName: string,
  projectId: string,
): string {
  const slug = projectName
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '')

  return `sp-${slug || 'projeto'}-${projectId.replace(/-/g, '').slice(0, 8)}`
}

/** Arquivos que não fazem diferença no build e só custam upload. */
const SKIP = [
  /^\.git\//,
  /^node_modules\//,
  /^\.next\//,
  /^coverage\//,
  /^playwright-report\//,
  /^test-results\//,
  /^e2e\//,
  /\.(png|jpe?g|gif|webp|avif|ico|woff2?|ttf|eot|mp4|webm|zip)$/i,
]

export function isDeployable(path: string): boolean {
  return !SKIP.some((pattern) => pattern.test(path))
}

export interface PublishResult {
  deployment: Deployment
  projectName: string
}

/**
 * Busca a anon key do projeto Supabase pela Management API.
 *
 * Sem ela, qualquer página que usa o cliente de navegador — a começar pelo
 * login — estoura ao renderizar ("Supabase não configurado"), e o preview
 * mostra "This page couldn't load". A anon key é pública (protegida por RLS),
 * então pode ir para o build do preview sem risco.
 *
 * Best-effort: se a busca falha, o preview ainda sobe (só as telas que
 * dependem de auth não abrem), então devolve null em vez de estourar.
 */
export async function getSupabaseAnonKey(
  accessToken: string,
  projectRef: string,
): Promise<string | null> {
  try {
    const response = await fetch(
      `https://api.supabase.com/v1/projects/${projectRef}/api-keys`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        cache: 'no-store',
      },
    )
    if (!response.ok) return null

    const keys = (await response.json()) as Array<{
      name?: string
      api_key?: string
    }>
    return keys.find((key) => key.name === 'anon')?.api_key ?? null
  } catch {
    return null
  }
}

/**
 * Publica um preview a partir dos arquivos do repositório.
 *
 * Cria o projeto na conta compartilhada na primeira vez e o reaproveita
 * depois — cada publicação vira um deploy novo com URL própria.
 */
export async function publishSharedPreview(
  config: SharedPreviewConfig,
  projectName: string,
  files: DeployFile[],
  options: {
    branch?: string
    supabaseUrl?: string
    supabaseAnonKey?: string
  } = {},
): Promise<PublishResult> {
  const deployable = files.filter((file) => isDeployable(file.path))

  if (deployable.length === 0) {
    throw new Error('Nenhum arquivo publicável no repositório.')
  }

  const existing = await findProjectByName(
    config.token,
    config.teamId,
    projectName,
  )

  const project =
    existing ??
    (await createDetachedProject(config.token, config.teamId, projectName))

  // Projetos criados antes desta correção nasceram protegidos; garantir a
  // cada publicação é barato e conserta os que já existem.
  if (existing) {
    await makePubliclyAccessible(config.token, config.teamId, project.id)
  }

  // SUPREMO_PREVIEW diz à aplicação que ela está num preview, e é o que
  // libera abrir dentro do painel. Depender do rótulo da Vercel não serve:
  // um deploy por envio de arquivos pode vir marcado como produção.
  //
  // As chaves do Supabase precisam existir no build, senão a aplicação sobe
  // sem conseguir falar com o banco.
  await setEnvironmentVariables(config.token, config.teamId, project.id, {
    SUPREMO_PREVIEW: '1',
    ...(options.supabaseUrl
      ? { NEXT_PUBLIC_SUPABASE_URL: options.supabaseUrl }
      : {}),
    ...(options.supabaseAnonKey
      ? { NEXT_PUBLIC_SUPABASE_ANON_KEY: options.supabaseAnonKey }
      : {}),
  })

  const deployment = await deployFiles(
    config.token,
    config.teamId,
    projectName,
    deployable,
    options.branch ? { supremoBranch: options.branch } : {},
  )

  return { deployment, projectName }
}

/**
 * Remove o projeto de preview da conta compartilhada.
 *
 * Chamado ao excluir o projeto no Supremo: preview é acessório do projeto e
 * não deve sobreviver a ele.
 */
export async function deleteSharedPreview(
  config: SharedPreviewConfig,
  projectName: string,
): Promise<'deleted' | 'already_gone'> {
  return deleteVercelProject(config.token, config.teamId, projectName)
}

export interface PreviewFailure {
  state: string
  url: string | null
  inspectorUrl: string | null
  log: string
}

/**
 * Por que o último preview falhou.
 *
 * O agente chama isto depois de publicar e ver que não subiu. Devolver o
 * estado sem o log deixaria ele adivinhando.
 */
export async function readPreviewFailure(
  config: SharedPreviewConfig,
  projectName: string,
): Promise<PreviewFailure | null> {
  const project = await findProjectByName(
    config.token,
    config.teamId,
    projectName,
  )
  if (!project) return null

  const deployment = await latestDeployment(
    config.token,
    config.teamId,
    project.id,
  )
  if (!deployment) return null

  if (deployment.state !== 'ERROR' && deployment.state !== 'CANCELED') {
    return null
  }

  const lines = await deploymentLogs(config.token, config.teamId, deployment.id)

  return {
    state: deployment.state,
    url: deployment.url,
    inspectorUrl: deployment.inspectorUrl,
    log: extractBuildFailure(lines),
  }
}

/** Estado do último preview publicado, sem republicar. */
export async function readSharedPreview(
  config: SharedPreviewConfig,
  projectName: string,
): Promise<Deployment | null> {
  try {
    const project = await findProjectByName(
      config.token,
      config.teamId,
      projectName,
    )
    if (!project) return null

    return await latestDeployment(config.token, config.teamId, project.id)
  } catch (error) {
    // Projeto ainda não criado é o caso normal antes da primeira publicação.
    if (error instanceof VercelError && error.status === 404) return null
    throw error
  }
}
