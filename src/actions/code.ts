'use server'

import { z } from 'zod'
import { requireProjectOwner, toActionError } from '@/lib/auth'
import { decryptToken } from '@/lib/crypto'
import { listTree, readFile } from '@/lib/mcp/github'
import type { GithubCredentials } from '@/lib/mcp/repository'

/**
 * O código do projeto, lido dentro do Supremo — para não precisar pular ao
 * GitHub só para olhar um arquivo. Read-only: editar código continua indo pelo
 * agente e pelos gates, porque é código que os testes provam (diferente de
 * dado, que a aba do Banco edita direto).
 */

const PROJECT_COLUMNS =
  'id, user_id, github_account_id, github_repo_full_name, default_branch'

/** Arquivos que não interessa listar (nem existem no repo, mas por garantia). */
const SKIP = /^(node_modules|\.next|\.git|dist|build|coverage)\//

async function resolveGithub(projectId: string): Promise<
  | { ok: true; creds: GithubCredentials }
  | { ok: false; error: string }
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
    .select('access_token_encrypted')
    .eq('id', accountId)
    .eq('user_id', user.id)
    .maybeSingle()
  if (!account) return { ok: false, error: 'Conta GitHub não encontrada.' }

  const [owner, repo] = repoFullName.split('/')
  if (!owner || !repo) return { ok: false, error: 'Repositório inválido.' }

  const defaultBranch = (project.default_branch as string | null) ?? 'main'
  return {
    ok: true,
    creds: {
      token: decryptToken(account.access_token_encrypted as string),
      repoFullName,
      owner,
      repo,
      branch: defaultBranch,
      defaultBranch,
    },
  }
}

export async function getRepoTree(
  projectId: string,
): Promise<{ files?: string[]; error?: string }> {
  if (!z.string().uuid().safeParse(projectId).success) {
    return { error: 'ID inválido.' }
  }

  try {
    const resolved = await resolveGithub(projectId)
    if (!resolved.ok) return { error: resolved.error }

    const tree = await listTree(resolved.creds, resolved.creds.defaultBranch)
    const files = tree
      .map((entry) => entry.path)
      .filter((path) => !SKIP.test(path))
      .sort()

    return { files }
  } catch (error) {
    return { error: toActionError(error) }
  }
}

const MAX_BYTES = 300_000

export async function getFileContent(
  projectId: string,
  path: string,
): Promise<{ content?: string; error?: string }> {
  if (!z.string().uuid().safeParse(projectId).success) {
    return { error: 'ID inválido.' }
  }
  if (!path || path.includes('..') || path.startsWith('/')) {
    return { error: 'Caminho inválido.' }
  }

  try {
    const resolved = await resolveGithub(projectId)
    if (!resolved.ok) return { error: resolved.error }

    const content = await readFile(
      resolved.creds,
      path,
      resolved.creds.defaultBranch,
    )

    if (content.length > MAX_BYTES) {
      return {
        content:
          content.slice(0, MAX_BYTES) + '\n\n… (arquivo grande, cortado)',
      }
    }
    return { content }
  } catch (error) {
    return { error: toActionError(error) }
  }
}
