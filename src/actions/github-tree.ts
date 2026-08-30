'use server'

import { requireProjectOwner } from '@/lib/auth'
import { decryptToken } from '@/lib/crypto'

interface WebContainerFile {
  file: { contents: string }
}
interface WebContainerDirectory {
  directory: Record<string, WebContainerFile | WebContainerDirectory>
}
type FileSystemTree = Record<string, WebContainerFile | WebContainerDirectory>

interface GithubTreeEntry {
  path: string
  type: string
  sha: string
  size?: number
}

interface GithubBlob {
  content: string
  encoding: string
}

/** Arquivos que o preview não precisa e que só custam requisição e memória. */
const SKIP_PATTERNS = [
  /^node_modules\//,
  /^\.git\//,
  /^\.next\//,
  /^dist\//,
  /^coverage\//,
  /\.(png|jpe?g|gif|webp|avif|ico|woff2?|ttf|eot|mp4|webm|pdf|zip)$/i,
]

/** Blob acima disto quase sempre é asset, não código. */
const MAX_BLOB_BYTES = 512 * 1024

export async function fetchGithubProjectTree(
  projectId: string
): Promise<FileSystemTree> {
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

  const token = decryptToken(account.access_token_encrypted as string)
  const branch = (project.default_branch as string | null) ?? 'main'

  const headers = {
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    Accept: 'application/vnd.github+json',
  }

  const treeResponse = await fetch(
    `https://api.github.com/repos/${repoFullName}/git/trees/${branch}?recursive=1`,
    { headers, cache: 'no-store' }
  )

  if (!treeResponse.ok) {
    throw new Error(
      `Falha ao ler a árvore do repositório (${treeResponse.status}).`
    )
  }

  const treeData = (await treeResponse.json()) as { tree: GithubTreeEntry[] }

  const blobs = treeData.tree.filter(
    (entry) =>
      entry.type === 'blob' &&
      (entry.size ?? 0) <= MAX_BLOB_BYTES &&
      !SKIP_PATTERNS.some((pattern) => pattern.test(entry.path))
  )

  const files = await Promise.all(
    blobs.map(async (blob) => {
      const blobResponse = await fetch(
        `https://api.github.com/repos/${repoFullName}/git/blobs/${blob.sha}`,
        { headers, cache: 'no-store' }
      )

      if (!blobResponse.ok) return null

      const data = (await blobResponse.json()) as GithubBlob
      return {
        path: blob.path,
        content: Buffer.from(data.content, 'base64').toString('utf8'),
      }
    })
  )

  return buildTree(files.filter((file): file is NonNullable<typeof file> => file !== null))
}

function buildTree(
  files: Array<{ path: string; content: string }>
): FileSystemTree {
  const root: FileSystemTree = {}

  for (const file of files) {
    const parts = file.path.split('/')
    let current = root

    for (let index = 0; index < parts.length; index++) {
      const part = parts[index]
      if (!part) continue

      if (index === parts.length - 1) {
        current[part] = { file: { contents: file.content } }
      } else {
        const existing = current[part]
        if (!existing || !('directory' in existing)) {
          current[part] = { directory: {} }
        }
        current = (current[part] as WebContainerDirectory).directory
      }
    }
  }

  return root
}
