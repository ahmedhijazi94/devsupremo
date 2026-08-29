import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import crypto from 'crypto'

async function getDecryptedToken(encryptedHex: string) {
  const [ivHex, authTagHex, encryptedDataHex] = encryptedHex.split(':')
  const iv = Buffer.from(ivHex || '', 'hex')
  const authTag = Buffer.from(authTagHex || '', 'hex')
  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(process.env.ENCRYPTION_KEY || '', 'hex'), iv)
  decipher.setAuthTag(authTag)
  let token = decipher.update(encryptedDataHex || '', 'hex', 'utf8')
  token += decipher.final('utf8')
  return token
}

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const { projectId, action, params } = body

    if (!projectId || !action) {
      return NextResponse.json({ error: 'Missing projectId or action' }, { status: 400 })
    }

    const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
    const { data: project } = await supabase
      .from('projects')
      .select('*, github_accounts(*), supabase_accounts(*)')
      .eq('id', projectId)
      .single()

    if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

    // Action: Execute SQL
    if (action === 'supabase_execute_sql') {
      const acc = Array.isArray(project.supabase_accounts) ? project.supabase_accounts[0] : project.supabase_accounts
      const token = await getDecryptedToken(acc.access_token_encrypted)
      
      const res = await fetch(`https://api.supabase.com/v1/projects/${project.supabase_project_ref}/query`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ query: params.query })
      })
      const data = await res.json()
      return NextResponse.json({ result: data })
    }

    // Action: Read Github File
    if (action === 'github_read_file') {
      const acc = Array.isArray(project.github_accounts) ? project.github_accounts[0] : project.github_accounts
      const token = await getDecryptedToken(acc.access_token_encrypted)
      
      const res = await fetch(`https://api.github.com/repos/${project.github_repo_full_name}/contents/${params.path}`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'Accept': 'application/vnd.github.v3.raw'
        }
      })
      if (!res.ok) throw new Error('File not found')
      const content = await res.text()
      return NextResponse.json({ content })
    }

    // Action: Write Github File
    if (action === 'github_write_file') {
      const acc = Array.isArray(project.github_accounts) ? project.github_accounts[0] : project.github_accounts
      const token = await getDecryptedToken(acc.access_token_encrypted)
      
      // Get SHA if file exists
      let sha = undefined
      const getRes = await fetch(`https://api.github.com/repos/${project.github_repo_full_name}/contents/${params.path}`, {
        headers: { 'Authorization': `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' }
      })
      if (getRes.ok) {
        const fileData = await getRes.json()
        sha = fileData.sha
      }

      const res = await fetch(`https://api.github.com/repos/${project.github_repo_full_name}/contents/${params.path}`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          message: params.message || `Update ${params.path}`,
          content: Buffer.from(params.content).toString('base64'),
          sha
        })
      })
      const data = await res.json()
      return NextResponse.json({ result: data })
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 })

  } catch (error: any) {
    console.error('MCP API Error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
