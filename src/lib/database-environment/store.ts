import type { SupabaseClient } from '@supabase/supabase-js'
import { environmentSchema, type DatabaseEnvironment } from './policy'

export async function readEnvironment(client: SupabaseClient, projectId: string): Promise<DatabaseEnvironment | null> {
  const { data, error } = await client.from('project_database_environments')
    .select('project_ref, environment, source').eq('project_id', projectId).maybeSingle()
  if (error) throw new Error('Não foi possível verificar o ambiente do banco. Aplique a migration 018 no control plane antes de usar este fluxo.')
  return data ? environmentSchema.parse(data) : null
}

/** Somente a resposta de criação do provedor pode alimentar este registro. Nunca upsert. */
export async function registerDevelopment(client: SupabaseClient, projectId: string, projectRef: string): Promise<void> {
  const { error } = await client.from('project_database_environments').insert({
    project_id: projectId, project_ref: projectRef, environment: 'development', source: 'supremo_provisioned',
  })
  if (error) throw new Error('Não foi possível registrar a origem development do banco recém-criado. Nenhuma migration será aplicada.')
}
