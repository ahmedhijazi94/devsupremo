'use server'

import { z } from 'zod'
import { requireProjectOwner, toActionError } from '@/lib/auth'
import { freshGithubToken } from '@/lib/github-token'
import { getHeadSha, listTree, octokitFor, readFile } from '@/lib/mcp/github'
import type { GithubCredentials } from '@/lib/mcp/repository'

/**
 * Sync incremental do projeto para o Browser Runtime.
 *
 * O navegador NUNCA recebe token do GitHub. Toda leitura privilegiada é aqui, no
 * servidor; o browser recebe só a lista de arquivos, o conteúdo pedido e a
 * revisão (SHA). Com a revisão em cache, o browser pega só o DELTA (compare API
 * do GitHub) em vez de rebaixar o repo — GitHub segue como fonte da verdade.
 */

const PROJECT_COLUMNS =
  'id, user_id, github_account_id, github_repo_full_name, default_branch'

/** Fora do preview: não interessa sincronizar para o browser. */
const SKIP =
  /^(node_modules|\.next|\.git|dist|build|coverage|\.github)\/|package-lock\.json$/

const MAX_FILE_BYTES = 300_000
const MAX_BATCH = 60

async function resolveGithub(
  projectId: string,
): Promise<
  { ok: true; creds: GithubCredentials } | { ok: false; error: string }
> {
  const { user, supabase, project } = await requireProjectOwner(
    projectId,
    PROJECT_COLUMNS,
  )
  const repoFullName = project.github_repo_full_name as string | null
  const accountId = project.github_account_id as string | null
  if (!repoFullName || !accountId) {
    return { ok: false, error: 'Projeto ainda não provisionado no GitHub.' }
  }

  const { data: account } = await supabase
    .from('github_accounts')
    .select('access_token_encrypted, refresh_token_encrypted, token_expires_at')
    .eq('id', accountId)
    .eq('user_id', user.id)
    .maybeSingle()
  if (!account) return { ok: false, error: 'Conta GitHub não encontrada.' }

  const [owner, repo] = repoFullName.split('/')
  if (!owner || !repo) return { ok: false, error: 'Repositório inválido.' }

  const token = await freshGithubToken(account, (update) =>
    supabase
      .from('github_accounts')
      .update(update)
      .eq('id', accountId)
      .eq('user_id', user.id),
  )
  const defaultBranch = (project.default_branch as string | null) ?? 'main'

  return {
    ok: true,
    creds: {
      token,
      repoFullName,
      owner,
      repo,
      branch: defaultBranch,
      defaultBranch,
    },
  }
}

export interface ProjectSnapshot {
  /** SHA do HEAD — a chave do cache no browser (por user/project/revision). */
  revision: string
  /** Caminhos relevantes ao preview; o conteúdo vem por getRuntimeFiles. */
  files: string[]
}

/** Foto inicial: a lista de arquivos e a revisão. Sem conteúdo (vem em lote). */
export async function getProjectSnapshot(
  projectId: string,
): Promise<{ snapshot?: ProjectSnapshot; error?: string }> {
  if (!z.string().uuid().safeParse(projectId).success) {
    return { error: 'ID inválido.' }
  }
  try {
    const resolved = await resolveGithub(projectId)
    if (!resolved.ok) return { error: resolved.error }
    const { creds } = resolved

    const revision = await getHeadSha(creds, creds.defaultBranch)
    const tree = await listTree(creds, revision)
    const files = tree
      .map((entry) => entry.path)
      .filter((path) => !SKIP.test(path))
      .sort()

    return { snapshot: { revision, files } }
  } catch (error) {
    return { error: toActionError(error) }
  }
}

export interface RuntimeDelta {
  revision: string
  changed: string[]
  deleted: string[]
  /** Cache velho/divergente: o browser deve refazer o snapshot inteiro. */
  resync: boolean
}

/**
 * O delta desde a revisão em cache. Usa o compare API do GitHub — o backend já
 * sabe o que mudou, então o browser não faz polling nem rebaixa o repo.
 */
export async function getChangedSince(
  projectId: string,
  sinceRevision: string,
): Promise<{ delta?: RuntimeDelta; error?: string }> {
  if (!z.string().uuid().safeParse(projectId).success) {
    return { error: 'ID inválido.' }
  }
  if (!/^[0-9a-f]{7,40}$/i.test(sinceRevision)) {
    return { error: 'Revisão inválida.' }
  }
  try {
    const resolved = await resolveGithub(projectId)
    if (!resolved.ok) return { error: resolved.error }
    const { creds } = resolved

    const revision = await getHeadSha(creds, creds.defaultBranch)
    if (revision === sinceRevision) {
      return { delta: { revision, changed: [], deleted: [], resync: false } }
    }

    const gh = octokitFor(creds)
    try {
      const { data } = await gh.repos.compareCommitsWithBasehead({
        owner: creds.owner,
        repo: creds.repo,
        basehead: `${sinceRevision}...${revision}`,
      })
      const changed: string[] = []
      const deleted: string[] = []
      for (const file of data.files ?? []) {
        if (SKIP.test(file.filename)) continue
        if (file.status === 'removed') deleted.push(file.filename)
        else changed.push(file.filename)
        // 'renamed' traz previous_filename; o antigo some do cache.
        if (file.status === 'renamed' && file.previous_filename) {
          deleted.push(file.previous_filename)
        }
      }
      return { delta: { revision, changed, deleted, resync: false } }
    } catch {
      // Base fora do histórico (rebase/força): o browser refaz o snapshot.
      return { delta: { revision, changed: [], deleted: [], resync: true } }
    }
  } catch (error) {
    return { error: toActionError(error) }
  }
}

export interface RuntimeFile {
  path: string
  content: string
}

/**
 * Conteúdo de um lote de arquivos, lido no servidor. É por aqui que o browser
 * pega o que precisa — o token do GitHub nunca sai daqui.
 */
export async function getRuntimeFiles(
  projectId: string,
  paths: string[],
): Promise<{ files?: RuntimeFile[]; error?: string }> {
  if (!z.string().uuid().safeParse(projectId).success) {
    return { error: 'ID inválido.' }
  }
  if (!Array.isArray(paths) || paths.length === 0) {
    return { error: 'Nenhum arquivo pedido.' }
  }
  if (paths.length > MAX_BATCH) {
    return { error: `No máximo ${MAX_BATCH} arquivos por lote.` }
  }
  // Caminhos seguros e dentro do que interessa ao preview.
  for (const path of paths) {
    if (typeof path !== 'string' || path.includes('..') || path.startsWith('/')) {
      return { error: `Caminho inválido: ${path}` }
    }
  }

  try {
    const resolved = await resolveGithub(projectId)
    if (!resolved.ok) return { error: resolved.error }
    const { creds } = resolved

    const files = await Promise.all(
      paths.map(async (path): Promise<RuntimeFile | null> => {
        try {
          const content = await readFile(creds, path, creds.defaultBranch)
          if (content.length > MAX_FILE_BYTES) return null // grande: fora do preview
          return { path, content }
        } catch {
          return null // sumiu entre o snapshot e a leitura — ignora
        }
      }),
    )

    return { files: files.filter((f): f is RuntimeFile => f !== null) }
  } catch (error) {
    return { error: toActionError(error) }
  }
}
