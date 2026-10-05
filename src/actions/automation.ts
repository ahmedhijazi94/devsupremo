'use server'

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { requireUser } from '@/lib/auth'
import { createServiceClient } from '@/lib/supabase/admin'
import { describeEnvironment } from '@/lib/database-environment/policy'
import { readEnvironment } from '@/lib/database-environment/store'
import { policyInputSchema, type OperationPolicy, type OperationReceipt } from '@/lib/backend-operations/contract'
import { readOperationPolicy } from '@/lib/backend-operations/server'
import { operationReceipt } from '@/lib/backend-operations/store'

export type AutomationStatus = { ok: true; environment: 'development' | 'production' | 'unknown'; projectRef: string | null; policy: OperationPolicy | null; operations: OperationReceipt[]; devices: Array<{ id: string; label: string }> } | { ok: false; error: string }

export async function getProjectAutomation(raw: unknown): Promise<AutomationStatus> {
  const projectId = z.string().uuid().safeParse(raw)
  if (!projectId.success) return { ok: false, error: 'Projeto inválido.' }
  try {
    const { user } = await requireUser()
    const client = createServiceClient()
    const { data: project, error } = await client.from('projects').select('id,supabase_project_ref').eq('id', projectId.data).eq('user_id', user.id).maybeSingle()
    if (error || !project) return { ok: false, error: 'Projeto não autorizado.' }
    const state = describeEnvironment(await readEnvironment(client, projectId.data), project.supabase_project_ref)
    const environment = state.environment === 'development' ? 'development' : state.environment === 'production' ? 'production' : 'unknown'
    const policy = environment === 'unknown' ? null : await readOperationPolicy(client, user.id, projectId.data, environment)
    const result = await client.from('project_backend_operations').select('*').eq('project_id', projectId.data).eq('user_id', user.id).order('created_at', { ascending: false }).limit(30)
    if (result.error) return { ok: false, error: 'O motor precisa receber as migrations de automação antes de mostrar as operações.' }
    const devices = await client.from('checkpoint_devices').select('id,device_label').eq('owner_user_id', user.id).is('revoked_at', null).limit(50)
    if (devices.error) return { ok: false, error: 'Não foi possível consultar os dispositivos autorizados.' }
    if ((await requireUser()).user.id !== user.id) return { ok: false, error: 'Sua sessão mudou. Entre novamente.' }
    return { ok: true, environment, projectRef: state.projectRef, policy, operations: (result.data ?? []).map(row => operationReceipt(row)), devices: (devices.data ?? []).map(row => ({ id: String(row.id), label: typeof row.device_label === 'string' ? row.device_label : 'Computador autorizado' })) }
  } catch { return { ok: false, error: 'Não foi possível carregar a automação. Confira a sessão e as migrations do motor.' } }
}

export async function saveProjectAutomation(raw: unknown): Promise<{ ok: true; revision: string } | { ok: false; error: string }> {
  const parsed = policyInputSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, error: 'Confira as capacidades e os limites da autorização.' }
  try {
    const input = parsed.data
    const { user } = await requireUser()
    const client = createServiceClient()
    const { data: project, error } = await client.from('projects').select('id,supabase_project_ref').eq('id', input.projectId).eq('user_id', user.id).maybeSingle()
    if (error || !project) return { ok: false, error: 'Projeto não autorizado.' }
    const environment = describeEnvironment(await readEnvironment(client, input.projectId), project.supabase_project_ref)
    if (environment.environment !== input.environment) return { ok: false, error: 'O ambiente mudou. Atualize o painel antes de autorizar.' }
    if ((await requireUser()).user.id !== user.id) return { ok: false, error: 'A sessão mudou. Entre novamente.' }
    if (input.deviceIds.length) {
      const devices = await client.from('checkpoint_devices').select('id').eq('owner_user_id', user.id).is('revoked_at', null).in('id', input.deviceIds)
      if (devices.error || devices.data?.length !== new Set(input.deviceIds).size) return { ok: false, error: 'Um dispositivo não está mais autorizado. Atualize a lista.' }
    }
    const result = await client.rpc('save_project_automation_policy', { p_owner: user.id, p_project: input.projectId,
      p_environment: input.environment, p_expected: input.expectedRevision, p_settings: input })
    if (result.error || typeof result.data !== 'string') return { ok: false, error: 'A autorização não foi salva. Atualize o painel: a política pode ter mudado em outra janela.' }
    revalidatePath(`/projects/${input.projectId}`)
    return { ok: true, revision: result.data }
  } catch { return { ok: false, error: 'Não foi possível salvar a autorização. Nenhuma nova permissão foi concedida.' } }
}
