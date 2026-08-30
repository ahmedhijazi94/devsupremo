'use server'

import { requireProjectOwner } from '@/lib/auth'
import { decryptToken } from '@/lib/crypto'

interface RepoAccess {
  token: string
  repoFullName: string
  branch: string
}

interface CompareFile {
  filename: string
  status: string
  sha: string
}

export interface ChangedFile {
  path: string
  status: string
  content: string | null
}

async function repoAccess(projectId: string): Promise<RepoAccess> {
  const { user, supabase, project } = await requireProjectOwner(
    projectId,
    'id, user_id, github_account_id, github_repo_full_name, default_branch'
  )

  const repoFullName = project.github_repo_full_name as string | null
  const githubAccountId = project.github_account_id as string | null

  if (!repoFullName || !githubAccountId) {
    throw new Error('Projeto não está conectado a um repositório GitHub.')
  }

  const { data: account } = await supabase
    .from('github_accounts')
    .select('access_token_encrypted')
    .eq('id', githubAccountId)
    .eq('user_id', user.id)
    .maybeSingle()

  if (!account) throw new Error('Conta GitHub não encontrada.')

  return {
    token: decryptToken(account.access_token_encrypted as string),
    repoFullName,
    branch: (project.default_branch as string | null) ?? 'main',
  }
}

function githubHeaders(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    Accept: 'application/vnd.github+json',
  }
}

export async function getLatestCommitSha(projectId: string): Promise<string> {
  const { token, repoFullName, branch } = await repoAccess(projectId)

  const response = await fetch(
    `https://api.github.com/repos/${repoFullName}/commits/${branch}`,
    { headers: githubHeaders(token), cache: 'no-store' }
  )

  if (!response.ok) {
    throw new Error(`Falha ao ler o último commit (${response.status}).`)
  }

  const data = (await response.json()) as { sha: string }
  return data.sha
}

export async function getChangedFilesContent(
  projectId: string,
  baseSha: string,
  headSha: string
): Promise<ChangedFile[]> {
  const { token, repoFullName } = await repoAccess(projectId)
  const headers = githubHeaders(token)

  const response = await fetch(
    `https://api.github.com/repos/${repoFullName}/compare/${baseSha}...${headSha}`,
    { headers, cache: 'no-store' }
  )

  if (!response.ok) {
    throw new Error(`Falha ao comparar commits (${response.status}).`)
  }

  const data = (await response.json()) as { files?: CompareFile[] }

  return Promise.all(
    (data.files ?? []).map(async (file): Promise<ChangedFile> => {
      if (file.status === 'removed') {
        return { path: file.filename, status: 'removed', content: null }
      }

      const blobResponse = await fetch(
        `https://api.github.com/repos/${repoFullName}/git/blobs/${file.sha}`,
        { headers, cache: 'no-store' }
      )

      if (!blobResponse.ok) {
        return { path: file.filename, status: file.status, content: null }
      }

      const blob = (await blobResponse.json()) as { content: string }
      return {
        path: file.filename,
        status: file.status,
        content: Buffer.from(blob.content, 'base64').toString('utf8'),
      }
    })
  )
}
