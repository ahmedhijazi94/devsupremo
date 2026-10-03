import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getProject, getSupabaseCredentials } from '../projects/repository'
import { readEnvironment } from '../database-environment/store'
import { requireDevelopment } from '../database-environment/policy'
import { DataDeleteError, type DeleteOptions, type DeleteResponse } from './contract'
import { runDataDelete } from './service'
import { supabaseDeleteProvider } from './provider'

export interface DeleteAuthority {
  client: SupabaseClient
  ownerId: string
  projectId: string
  expectedRef: string
  verifyIdentity(): Promise<string>
}

export async function runAuthorizedDelete(authority: DeleteAuthority, options: DeleteOptions): Promise<DeleteResponse> {
  const authorize = async () => {
    if (await authority.verifyIdentity() !== authority.ownerId) throw new DataDeleteError('Dispositivo não autorizado.', 401)
    const project = await getProject(authority.ownerId, authority.projectId)
    try { requireDevelopment(await readEnvironment(authority.client, project.id), project.supabase_project_ref, authority.expectedRef) }
    catch { throw new DataDeleteError('Exclusão exige development registrado pelo Supremo e vínculo confirmado. Consulte db status.') }
    if (!project.supabase_account_id) throw new DataDeleteError('Conta do banco indisponível.')
    return { project, scope: { ownerId: authority.ownerId, projectId: project.id, accountId: project.supabase_account_id,
      projectRef: authority.expectedRef, environment: 'development' as const } }
  }
  const initial = await authorize()
  const verify = async () => {
    const current = await authorize()
    if (current.scope.accountId !== initial.scope.accountId) throw new DataDeleteError('Conta do banco mudou. Prepare outro plano.')
    return current
  }
  const provider = supabaseDeleteProvider(async () => {
    const { project } = await verify()
    const credentials = await getSupabaseCredentials(authority.ownerId, project)
    await verify()
    if (credentials.projectRef !== authority.expectedRef) throw new DataDeleteError('Vínculo do banco mudou. Prepare outro plano.')
    return credentials
  })
  return runDataDelete({ provider, authorize: async () => (await verify()).scope, audit: async event => {
    await verify()
    // audit_logs is append-only. Its existing UUID primary key atomically consumes
    // the plan across workers, and is retained even if the provider times out.
    const result = await authority.client.from('audit_logs').insert({
      ...(event.event === 'claimed' ? { id: event.planId } : {}),
      user_id: authority.ownerId, action: `data-delete.${event.event}`, resource_type: 'project', resource_id: authority.projectId,
      metadata: { ...event.metadata, planId: event.planId }, ip_address: null,
    })
    if (result.error?.code === '23505' && event.event === 'claimed')
      throw new DataDeleteError('Este plano já foi utilizado. Consulte os registros antes de preparar outro; a exclusão não será repetida.')
    if (result.error) throw new DataDeleteError('Não foi possível registrar a operação de exclusão. Resultado não confirmado.', 503)
  } }, options)
}
