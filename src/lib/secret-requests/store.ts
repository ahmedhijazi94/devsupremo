import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { readEnvironment } from '@/lib/database-environment/store'
import { getProject, getSupabaseCredentials } from '@/lib/projects/repository'
import { decryptToken } from '@/lib/crypto'
import { assertSameBinding, requireSecretBinding, secretEnvironmentSchema, secretTargetSchema, SecretRequestError, type SecretRequestRecord } from './policy'
import type { SecretRequestPort } from './service'
import { deliverSecret } from './provider'
import { secretRequestStorageError } from './storage-errors'

const rowSchema = z.object({ id: z.string().uuid(), name: z.string(), description: z.string().nullable(), target: secretTargetSchema.nullable(),
  environment: secretEnvironmentSchema.nullable(), target_ref: z.string().nullable(), target_account_id: z.string().nullable(), status: z.enum(['pending', 'fulfilled']) })
const columns = 'id,name,description,target,environment,target_ref,target_account_id,status'
function record(row: unknown): SecretRequestRecord {
  const parsed = rowSchema.parse(row)
  return { id: parsed.id, name: parsed.name, description: parsed.description, target: parsed.target, environment: parsed.environment,
    targetRef: parsed.target_ref, accountId: parsed.target_account_id, status: parsed.status }
}
export function secretRequestStore(client: SupabaseClient, userId: string, projectId: string): SecretRequestPort {
  const owned = async () => {
    const result = await client.from('projects').select('id,supabase_account_id,supabase_project_ref,vercel_account_id,vercel_project_id').eq('id', projectId).eq('user_id', userId).maybeSingle()
    if (result.error || !result.data) throw new SecretRequestError('Projeto não encontrado ou não autorizado.')
    return result.data as { id: string; supabase_account_id: string | null; supabase_project_ref: string | null; vercel_account_id: string | null; vercel_project_id: string | null }
  }
  const scoped = () => client.from('secret_requests').select(columns).eq('project_id', projectId).eq('user_id', userId)
  const port: SecretRequestPort = {
    authorize: async () => { await owned() },
    resolve: async (entry) => {
      const project = await owned()
      const isSupabase = entry.target === 'supabase'
      const accountId = isSupabase ? project.supabase_account_id : project.vercel_account_id
      const targetRef = isSupabase ? project.supabase_project_ref : project.vercel_project_id
      const binding = requireSecretBinding({ ...entry, accountId, targetRef, databaseEnvironment: isSupabase ? await readEnvironment(client, projectId) : null })
      const account = await client.from(isSupabase ? 'supabase_accounts' : 'vercel_accounts').select('id').eq('id', binding.accountId).eq('user_id', userId).maybeSingle()
      if (account.error || !account.data) throw new SecretRequestError('Conta do destino não encontrada ou não autorizada.')
      return binding
    },
    list: async () => {
      const result = await scoped().order('created_at', { ascending: true }).limit(101)
      if (result.error) throw secretRequestStorageError(result.error)
      return (result.data ?? []).map(record)
    },
    insert: async (entries) => {
      const result = await client.from('secret_requests').upsert(entries.map((entry) => ({ user_id: userId, project_id: projectId, name: entry.name,
        description: entry.description, target: entry.target, environment: entry.environment, target_ref: entry.targetRef, target_account_id: entry.accountId, is_secret: true })),
      { onConflict: 'project_id,name,target,environment,target_ref,target_account_id', ignoreDuplicates: true })
      if (result.error) throw secretRequestStorageError(result.error)
    },
    find: async (id) => { const result = await scoped().eq('id', id).maybeSingle(); if (result.error) throw secretRequestStorageError(result.error); return result.data ? record(result.data) : null },
    audit: async (row) => {
      const result = await client.from('audit_logs').insert({ user_id: userId, action: 'secret.delivery_requested', resource_type: 'project', resource_id: projectId,
        metadata: { requestId: row.id, name: row.name, target: row.target, environment: row.environment, targetRef: row.targetRef }, ip_address: null })
      if (result.error) throw new SecretRequestError('Não foi possível registrar o envio; o valor ainda não foi enviado.')
    },
    deliver: async (row, binding, value) => {
      let token: string
      let teamId: string | null = null
      if (binding.target === 'supabase') {
        const project = await getProject(userId, projectId)
        if (project.supabase_account_id !== binding.accountId || project.supabase_project_ref !== binding.targetRef) throw new SecretRequestError('O vínculo Supabase mudou. Solicite novamente.')
        token = (await getSupabaseCredentials(userId, project)).token
      } else {
        const account = await client.from('vercel_accounts').select('access_token_encrypted,team_id').eq('id', binding.accountId).eq('user_id', userId).maybeSingle()
        if (account.error || !account.data) throw new SecretRequestError('Conta Vercel não autorizada.')
        token = decryptToken(account.data.access_token_encrypted as string)
        teamId = account.data.team_id as string | null
      }
      // Refresh/credential I/O may take time. Recheck the actual owner, account, ref and environment immediately before dispatch.
      assertSameBinding(row, await port.resolve(binding))
      await deliverSecret(binding, row.name, value, token, teamId)
    },
    fulfill: async (row) => {
      const result = await client.from('secret_requests').update({ status: 'fulfilled', fulfilled_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('id', row.id).eq('project_id', projectId).eq('user_id', userId).eq('target_ref', row.targetRef).eq('target_account_id', row.accountId).select('id').maybeSingle()
      if (result.error || !result.data) throw new SecretRequestError('Confirmação não persistida.')
    },
    dismiss: async (id) => {
      const result = await client.from('secret_requests').delete().eq('id', id).eq('project_id', projectId).eq('user_id', userId)
      if (result.error) throw secretRequestStorageError(result.error)
    },
  }
  return port
}
