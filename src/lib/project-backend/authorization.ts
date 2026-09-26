import { describeEnvironment } from '../database-environment/policy'
import { InspectionError } from '../database-inspection/provider'
import type { BackendTarget } from './service'

export interface OwnedBackendProject { supabase_project_ref: string | null; supabase_account_id: string | null }
export interface BackendAuthority<P extends OwnedBackendProject> {
  ownerId: string
  identity(): Promise<string>
  project(ownerId: string): Promise<P>
  environment(): Promise<unknown>
  credentials(ownerId: string, project: P): Promise<{ projectRef: string; token: string }>
}

/** The panel has session authority, never a device secret or caller-supplied
 * owner. Pin account/ref/environment across token refresh and provider calls. */
export async function authorizeBackend<P extends OwnedBackendProject>(authority: BackendAuthority<P>) {
  const snapshot = async () => {
    if (await authority.identity() !== authority.ownerId) throw new InspectionError('Sua sessão mudou. Entre novamente.', 401)
    const project = await authority.project(authority.ownerId)
    const state = describeEnvironment(await authority.environment(), project.supabase_project_ref)
    if (!state.projectRef || !/^[a-z0-9_-]{1,64}$/.test(state.projectRef) || !project.supabase_account_id) throw new InspectionError('Conecte o Supabase a este projeto para abrir os dados.', 409)
    return { project, target: { projectRef: state.projectRef, environment: state.environment } as BackendTarget }
  }
  const initial = await snapshot()
  const verify = async () => {
    const current = await snapshot()
    if (current.project.supabase_account_id !== initial.project.supabase_account_id || current.target.projectRef !== initial.target.projectRef || current.target.environment !== initial.target.environment) throw new InspectionError('O banco, a conta ou o ambiente mudou. Atualize o painel.', 409)
    return current
  }
  return {
    target: initial.target, verify,
    async resolve(readOnly = true) {
      const current = await verify()
      if (!readOnly && current.target.environment === 'unknown') throw new InspectionError('Alterações exigem um ambiente confirmado pelo Supremo.', 409)
      const credentials = await authority.credentials(authority.ownerId, current.project)
      await verify()
      if (credentials.projectRef !== initial.target.projectRef) throw new InspectionError('O vínculo do banco mudou durante a autorização.', 409)
      return credentials
    },
  }
}
