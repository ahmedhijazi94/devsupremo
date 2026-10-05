import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getProject, getSupabaseCredentials } from '../projects/repository'
import { readEnvironment } from '../database-environment/store'
import { authorizeBackend } from '../project-backend/authorization'
import { readBackendUsage } from '../project-backend/service'
import { supabaseInspectionProvider } from '../database-inspection/provider'
import { authorizeProjectOperation, readOperationPolicy } from '../backend-operations/server'
import { OperationError } from '../backend-operations/contract'
import { assertSamePolicy } from '../backend-operations/policy'
import { usageLimitsSchema, usageReadSchema, usageSettingsSchema, usageSnapshotSchema, type UsageReport } from './contract'
import { usageAlerts, usageHour } from './service'

export interface UsageAuthority {
  client: SupabaseClient; ownerId: string; projectId: string; deviceId?: string; ownerSession?: true
  verifyIdentity(): Promise<string>
}
async function binding(authority: UsageAuthority, raw: unknown) {
  const input = usageReadSchema.parse(raw)
  if (input.projectId !== authority.projectId) throw new OperationError('Projeto não autorizado.', 403)
  const backend = await authorizeBackend({ ownerId: authority.ownerId, identity: authority.verifyIdentity,
    project: ownerId => getProject(ownerId, authority.projectId), environment: () => readEnvironment(authority.client, authority.projectId),
    credentials: getSupabaseCredentials })
  if (backend.target.environment !== input.environment || backend.target.projectRef !== input.expectedRef) throw new OperationError('O banco ou ambiente mudou. Atualize a consulta.', 409)
  let policy: { policyId: string; revision: string } | undefined
  const verify = async () => {
    await backend.verify()
    if (authority.ownerSession !== true) {
      const current = await authorizeProjectOperation({ ...authority, environment: input.environment }, 'data.read')
      if (policy) assertSamePolicy(policy, current)
      policy ??= current
    }
  }
  await verify()
  return { input, verify, resolve: async () => { await verify(); return backend.resolve() } }
}
export async function readAuthorizedUsage(authority: UsageAuthority, raw: unknown): Promise<UsageReport> {
  const { input, verify, resolve } = await binding(authority, raw)
  const since = new Date(Date.now() - input.days * 86_400_000).toISOString()
  const projectRows = (table: string) => authority.client.from(table).select('*').eq('user_id', authority.ownerId).eq('project_id', input.projectId).eq('target_ref', input.expectedRef).eq('environment', input.environment)
  const data = await readBackendUsage(supabaseInspectionProvider(resolve))
  const policy = await readOperationPolicy(authority.client, authority.ownerId, input.projectId, input.environment)
  const count = await authority.client.from('project_backend_operations').select('id', { count: 'exact', head: true }).eq('user_id', authority.ownerId).eq('project_id', input.projectId).eq('environment', input.environment).gte('created_at', new Date(Date.now() - 3_600_000).toISOString())
  const current = usageSnapshotSchema.parse({ observedAt: new Date().toISOString(), metrics: [...(data.metrics ?? []), {
    name: 'Operações do motor na última hora', value: count.error ? null : count.count ?? null, available: !count.error && typeof count.count === 'number',
    note: 'Pedidos admitidos pelo motor, incluindo falhas e resultados incertos. Não mede chamadas externas feitas fora dele.',
  }] })
  await verify()
  const stored = await authority.client.from('project_usage_snapshots').upsert({ user_id: authority.ownerId, project_id: input.projectId,
    target_ref: input.expectedRef, environment: input.environment, hour: usageHour(current.observedAt), observed_at: current.observedAt, metrics: current.metrics },
  { onConflict: 'project_id,target_ref,environment,hour', ignoreDuplicates: true })
  const [history, settings] = await Promise.all([
    projectRows('project_usage_snapshots').gte('observed_at', since).order('observed_at', { ascending: false }).limit(721),
    projectRows('project_usage_alert_settings').maybeSingle(),
  ])
  // Retain at most 30 days for this project across relinks; scoped to the owner.
  if (!stored.error) await authority.client.from('project_usage_snapshots').delete().eq('user_id', authority.ownerId).eq('project_id', input.projectId).lt('observed_at', new Date(Date.now() - 30 * 86_400_000).toISOString())
  await verify()
  const limits = settings.error ? [] : usageLimitsSchema.parse(settings.data?.limits ?? [])
  const available = !stored.error && !history.error && !settings.error
  return { projectRef: input.expectedRef, environment: input.environment, current,
    history: history.error ? [] : (history.data ?? []).map(row => usageSnapshotSchema.parse({ observedAt: row.observed_at, metrics: row.metrics })), limits, alerts: usageAlerts(current, limits),
    engineQuota: { maximum: policy?.maxOperationsPerHour ?? null, enabled: policy?.enabled ?? null, note: 'Limite de operações do Supremo definido em Automação; não é a cota do fornecedor.' },
    historyAvailable: available, historyMessage: available ? 'Uma amostra por hora em que o painel ou agente consulta o uso; retenção de 30 dias. Lacunas não são consumo zero. Alertas são avaliados nesta consulta, sem notificação externa.' : 'Histórico ou limites indisponíveis. Confira a migration 040. A leitura atual não substitui as amostras ausentes.',
    providerQuotasAvailable: false }
}
/** Device API cannot call this path: only a separately verified owner session
 * can set alert preferences, which never expand operation authority. */
export async function saveAuthorizedUsageLimits(authority: UsageAuthority & { verifyOwnerSession(): Promise<string> }, raw: unknown): Promise<void> {
  const input = usageSettingsSchema.parse(raw)
  if (await authority.verifyOwnerSession() !== authority.ownerId) throw new OperationError('Apenas o dono pode definir alertas.', 403)
  const { verify } = await binding({ ...authority, ownerSession: true }, { projectId: input.projectId, expectedRef: input.expectedRef, environment: input.environment })
  await verify()
  if (await authority.verifyOwnerSession() !== authority.ownerId) throw new OperationError('Sua sessão mudou.', 401)
  const result = await authority.client.from('project_usage_alert_settings').upsert({ user_id: authority.ownerId, project_id: input.projectId, target_ref: input.expectedRef,
    environment: input.environment, limits: input.limits }, { onConflict: 'project_id,target_ref,environment' })
  if (result.error) throw new OperationError('Os limites não foram salvos. Confira a migration 040.', 503)
  await verify()
}
