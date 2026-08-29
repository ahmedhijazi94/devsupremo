'use server'

import { createClient } from '@/lib/supabase/server'
import crypto from 'crypto'

async function getAuthHeaders(projectId: string) {
  const supabase = await createClient()
  const { data: project } = await supabase
    .from('projects')
    .select('github_repo_full_name, github_accounts(access_token_encrypted)')
    .eq('id', projectId)
    .single()

  if (!project || !project.github_repo_full_name || !project.github_accounts) {
    throw new Error('Project not found')
  }

  const acc = (Array.isArray(project.github_accounts) ? project.github_accounts[0] : project.github_accounts) as any
  const tokenHex = acc.access_token_encrypted as string
  const [ivHex, authTagHex, encryptedDataHex] = tokenHex.split(':')
  
  const iv = Buffer.from(ivHex || '', 'hex')
  const authTag = Buffer.from(authTagHex || '', 'hex')
  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(process.env.ENCRYPTION_KEY || '', 'hex'), iv)
  decipher.setAuthTag(authTag)
  let token = decipher.update(encryptedDataHex || '', 'hex', 'utf8')
  token += decipher.final('utf8')

  return { 
    token, 
    repoFullName: project.github_repo_full_name 
  }
}

export async function getLatestCommitSha(projectId: string): Promise<string> {
  const { token, repoFullName } = await getAuthHeaders(projectId)
  const res = await fetch(`https://api.github.com/repos/${repoFullName}/commits/main`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
    cache: 'no-store'
  })
  if (!res.ok) throw new Error('Failed to fetch latest commit')
  const data = await res.json()
  return data.sha
}

export async function getChangedFilesContent(projectId: string, baseSha: string, headSha: string) {
  const { token, repoFullName } = await getAuthHeaders(projectId)
  
  // 1. Get the diff
  const res = await fetch(`https://api.github.com/repos/${repoFullName}/compare/${baseSha}...${headSha}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
    cache: 'no-store'
  })
  if (!res.ok) throw new Error('Failed to fetch diff')
  const data = await res.json()

  // 2. Fetch raw content for added/modified files
  const files = await Promise.all(
    (data.files || []).map(async (f: any) => {
      if (f.status === 'removed') {
        return { path: f.filename, status: 'removed', content: null }
      }
      // For added/modified, fetch the blob
      const blobRes = await fetch(`https://api.github.com/repos/${repoFullName}/git/blobs/${f.sha}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
        cache: 'no-store'
      })
      const bData = await blobRes.json()
      return { 
        path: f.filename, 
        status: f.status, 
        content: Buffer.from(bData.content, 'base64').toString('utf8') 
      }
    })
  )

  return files
}
