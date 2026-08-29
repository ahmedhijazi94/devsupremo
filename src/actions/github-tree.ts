'use server'

import { createClient } from '@/lib/supabase/server'

interface WebContainerFile {
  file: { contents: string | Uint8Array }
}
interface WebContainerDirectory {
  directory: Record<string, WebContainerFile | WebContainerDirectory>
}
type FileSystemTree = Record<string, WebContainerFile | WebContainerDirectory>

export async function fetchGithubProjectTree(projectId: string): Promise<FileSystemTree> {
  const supabase = await createClient()
  const { data: project } = await supabase
    .from('projects')
    .select('github_repo_full_name, github_accounts(access_token_encrypted)')
    .eq('id', projectId)
    .single()

  if (!project || !project.github_repo_full_name || !project.github_accounts) {
    throw new Error('Project not found or not connected to GitHub')
  }

  const acc = (Array.isArray(project.github_accounts) ? project.github_accounts[0] : project.github_accounts) as any;
  const tokenHex = acc.access_token_encrypted as string;
  const [ivHex, authTagHex, encryptedDataHex] = tokenHex.split(':')
  const crypto = require('crypto')
  const iv = Buffer.from(ivHex || '', 'hex')
  const authTag = Buffer.from(authTagHex || '', 'hex')
  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(process.env.ENCRYPTION_KEY || '', 'hex'), iv)
  decipher.setAuthTag(authTag)
  let token = decipher.update(encryptedDataHex, 'hex', 'utf8')
  token += decipher.final('utf8')

  // 1. Get Tree
  const treeRes = await fetch(`https://api.github.com/repos/${project.github_repo_full_name}/git/trees/main?recursive=1`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    }
  })
  if (!treeRes.ok) throw new Error('Failed to fetch repo tree')
  const treeData = await treeRes.json()

  // 2. Fetch Blobs in parallel
  const blobs = treeData.tree.filter((t: any) => t.type === 'blob')
  
  const filesData = await Promise.all(
    blobs.map(async (blob: any) => {
      const res = await fetch(`https://api.github.com/repos/${project.github_repo_full_name}/git/blobs/${blob.sha}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
        }
      })
      const bData = await res.json()
      return { path: blob.path, content: Buffer.from(bData.content, 'base64').toString('utf8') }
    })
  )

  // 3. Convert to FileSystemTree format
  const tree: FileSystemTree = {}
  
  for (const file of filesData) {
    const parts = file.path.split('/')
    let current = tree
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      if (i === parts.length - 1) {
        current[part] = { file: { contents: file.content } }
      } else {
        if (!current[part]) {
          current[part] = { directory: {} }
        }
        current = (current[part] as WebContainerDirectory).directory
      }
    }
  }

  return tree
}
