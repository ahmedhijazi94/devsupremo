'use server'

import { z } from 'zod'
import { requireProjectOwner, toActionError } from '@/lib/auth'
import { freshGithubToken } from '@/lib/github-token'
import {
  commitFiles,
  ensureBranch,
  listTree,
  openOrUpdatePullRequest,
  readFile,
} from '@/lib/mcp/github'
import type { GithubCredentials } from '@/lib/mcp/repository'

/**
 * O código do projeto, dentro do Supremo — para não precisar pular ao GitHub só
 * para olhar (ou ajustar) um arquivo.
 *
 * Ler é direto. Editar NÃO escreve na base: abre um PR pelos mesmos gates que o
 * agente usa. É o que separa código de dado — o dado a aba do Banco muda na
 * hora porque teste não prova valor de linha; código é o que os testes provam,
 * então toda mudança de código passa pelos gates, venha do agente ou daqui.
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
    .select('access_token_encrypted, refresh_token_encrypted, token_expires_at')
    .eq('id', accountId)
    .eq('user_id', user.id)
    .maybeSingle()
  if (!account) return { ok: false, error: 'Conta GitHub não encontrada.' }

  const [owner, repo] = repoFullName.split('/')
  if (!owner || !repo) return { ok: false, error: 'Repositório inválido.' }

  // Renova o token de 8h pelo refresh, se expirou. Sem isto, tudo que fala com
  // o GitHub morre com "Bad credentials" depois do prazo.
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

/** Deriva um nome de branch estável do caminho, para reusar o PR ao reeditar. */
function branchForPath(path: string): string {
  const slug = path
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return `supremo/editar-${slug || 'arquivo'}`
}

export interface ProposeEditResult {
  prUrl: string
  prNumber: number
  branch: string
}

/**
 * Abre (ou atualiza) um PR com o novo conteúdo de um arquivo. Nunca escreve na
 * branch principal: os gates rodam no PR, e o merge é a última palavra. Um PR
 * por arquivo — reeditar o mesmo arquivo reusa o mesmo PR.
 */
export async function proposeFileEdit(input: {
  projectId: string
  path: string
  content: string
}): Promise<{ result?: ProposeEditResult; error?: string }> {
  const parsed = z
    .object({
      projectId: z.string().uuid(),
      path: z.string().min(1).max(400),
      content: z.string().max(MAX_BYTES),
    })
    .safeParse(input)
  if (!parsed.success) return { error: 'Dados inválidos.' }

  const { projectId, path, content } = parsed.data
  if (path.includes('..') || path.startsWith('/')) {
    return { error: 'Caminho inválido.' }
  }

  try {
    const resolved = await resolveGithub(projectId)
    if (!resolved.ok) return { error: resolved.error }
    const { creds } = resolved

    // Sem mudança real: não suja o repo com um PR vazio.
    const current = await readFile(creds, path, creds.defaultBranch).catch(
      () => null,
    )
    if (current !== null && current === content) {
      return { error: 'Nada mudou neste arquivo.' }
    }

    const branch = branchForPath(path)
    await ensureBranch(creds, branch, creds.defaultBranch)
    await commitFiles(creds, branch, `chore: editar ${path}`, [
      { path, content },
    ])
    const pr = await openOrUpdatePullRequest(
      creds,
      branch,
      `Editar ${path}`,
      [
        `Edição de \`${path}\` pela aba Código do Supremo.`,
        'Os gates rodam neste PR. Revise o diff e faça o merge quando ficar verde.',
      ].join('\n\n'),
      creds.defaultBranch,
    )

    return {
      result: { prUrl: pr.url, prNumber: pr.number, branch },
    }
  } catch (error) {
    return { error: toActionError(error) }
  }
}
