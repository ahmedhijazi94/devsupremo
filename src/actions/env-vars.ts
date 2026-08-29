'use server'

import { createClient } from '@/lib/supabase/server'
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

export async function getProjectEnvVars(projectId: string) {
  const supabase = await createClient()
  const { data: project } = await supabase
    .from('projects')
    .select('*, supabase_accounts(*)')
    .eq('id', projectId)
    .single()

  if (!project || !project.supabase_project_ref) return null

  let anonKey = ''
  
  if (project.supabase_accounts) {
    const acc = Array.isArray(project.supabase_accounts) ? project.supabase_accounts[0] : project.supabase_accounts
    const token = await getDecryptedToken(acc.access_token_encrypted)
    
    // Fetch API keys from Supabase Management API
    const res = await fetch(`https://api.supabase.com/v1/projects/${project.supabase_project_ref}/api-keys`, {
      headers: { Authorization: `Bearer ${token}` }
    })
    
    if (res.ok) {
      const keys = await res.json()
      const anonKeyObj = keys.find((k: any) => k.name === 'anon')
      if (anonKeyObj) anonKey = anonKeyObj.api_key
    }
  }

  return `NEXT_PUBLIC_SUPABASE_URL=https://${project.supabase_project_ref}.supabase.co\nNEXT_PUBLIC_SUPABASE_ANON_KEY=${anonKey}\n`
}
