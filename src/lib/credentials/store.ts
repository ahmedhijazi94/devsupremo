import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { SecretRequestError } from '@/lib/secret-requests/policy'
import { credentialNameSchema, projectCredentialSchema, type ProjectCredentialView } from './contract'
import type { CredentialPort, CredentialRecord } from './service'

const columns = 'id,name,environment,created_at,updated_at'
const rowSchema = z.object({ id: z.string().uuid(), name: credentialNameSchema, environment: projectCredentialSchema.shape.environment,
  created_at: z.string(), updated_at: z.string() })
function view(input: unknown): ProjectCredentialView {
  const row = rowSchema.parse(input)
  return projectCredentialSchema.parse({ id: row.id, name: row.name, environment: row.environment, createdAt: row.created_at, updatedAt: row.updated_at })
}
function storageFailure(): never { throw new SecretRequestError('Não foi possível acessar o cofre do projeto. Verifique a atualização e a conexão do Supremo.') }

/** Service client only. RLS forbids browser access, including ciphertext reads. */
export function credentialStore(client: SupabaseClient, userId: string, projectId: string): CredentialPort {
  const scoped = (fields: string) => client.from('project_credentials').select(fields).eq('user_id', userId).eq('project_id', projectId)
  const port: CredentialPort = {
    userId, projectId,
    authorize: async () => {
      const result = await client.from('projects').select('id').eq('id', projectId).eq('user_id', userId).maybeSingle()
      if (result.error || !result.data) throw new SecretRequestError('Projeto não encontrado ou não autorizado.')
    },
    list: async () => {
      const result = await scoped(columns).order('created_at', { ascending: false }).limit(1000)
      if (result.error) storageFailure()
      return (result.data ?? []).map(view)
    },
    find: async (id) => {
      const result = await scoped(`${columns},user_id,project_id,encrypted_value`).eq('id', id).maybeSingle()
      if (result.error) storageFailure()
      if (!result.data) return null
      const privateRow = z.object({ user_id: z.string().uuid(), project_id: z.string().uuid(), encrypted_value: z.string() }).parse(result.data)
      return { ...view(result.data), userId: privateRow.user_id, projectId: privateRow.project_id, encryptedValue: privateRow.encrypted_value }
    },
    insert: async (record: CredentialRecord) => {
      if (record.userId !== userId || record.projectId !== projectId) throw new SecretRequestError('Credencial fora do escopo do projeto.')
      const result = await client.from('project_credentials').insert({ id: record.id, user_id: userId, project_id: projectId, name: record.name,
        environment: record.environment, encrypted_value: record.encryptedValue, created_at: record.createdAt, updated_at: record.updatedAt }).select('id').maybeSingle()
      if (result.error || !result.data) storageFailure()
    },
    remove: async (id) => {
      const result = await client.from('project_credentials').delete().eq('id', id).eq('user_id', userId).eq('project_id', projectId)
      if (result.error) storageFailure()
    },
    audit: async (action, id, requestId) => {
      const result = await client.from('audit_logs').insert({ user_id: userId, action: `credential.${({ saved: 'save', used: 'use', removed: 'removal' } as const)[action]}_requested`, resource_type: 'project', resource_id: projectId,
        metadata: { credentialId: id, ...(requestId ? { requestId } : {}) }, ip_address: null })
      if (result.error) throw new SecretRequestError('Não foi possível registrar a operação do cofre. Tente novamente.')
    },
  }
  return port
}
