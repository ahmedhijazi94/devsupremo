import 'server-only'
import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { getProject, getSupabaseCredentials } from '../projects/repository'
import { readEnvironment } from '../database-environment/store'
import { requireDevelopment, validateAutomaticMigration } from '../database-environment/policy'
import { runDatabaseOperation } from '../database-environment/service'
import { boundedJson } from '../database-inspection/provider'
import { authorizeProjectOperation } from '../backend-operations/server'
import { backendOperationStore } from '../backend-operations/store'
import { runTrackedOperation } from '../backend-operations/service'
import { OperationApprovalRequired } from '../backend-operations/approval-contract'
import { advanceSqlArtifact, artifactDigest, assertMaterialization } from './service'
import { prepareSqlArtifactSchema, sqlArtifactSchema, SqlArtifactError, type SqlArtifact, type SqlArtifactSummary } from './contract'

export interface SqlArtifactAuthority {
  client: SupabaseClient; ownerId: string; projectId: string; expectedRef: string; deviceId?: string
  ownerSession?: true
  verifyIdentity(): Promise<string>
}
function artifact(raw: Record<string, unknown>): SqlArtifact {
  const file = String(raw.path)
  return sqlArtifactSchema.parse({ id: raw.id, projectId: raw.project_id, projectRef: raw.project_ref, environment: raw.environment,
    path: file, content: raw.content, digest: raw.content_digest, state: raw.state, claimToken: raw.claim_token, message: raw.message,
    types: raw.types_content === null ? null : { path: file.replace('supabase/migrations/', 'supabase/types/').replace(/\.sql$/, '.types.ts'), content: raw.types_content, digest: raw.types_digest },
    updatedAt: raw.updated_at })
}
async function authorize(scope: SqlArtifactAuthority) {
  // Preparing an immutable artifact is not permission to apply SQL. The exact
  // schema operation is authorized inside its receipt context before dispatch.
  const policy = await authorizeProjectOperation({ ...scope, environment: 'development' }, 'data.read', { resource: 'supabase/migrations' })
  const project = await getProject(scope.ownerId, scope.projectId)
  const record = await readEnvironment(scope.client, scope.projectId)
  requireDevelopment(record, project.supabase_project_ref, scope.expectedRef)
  return { project, record, policy }
}
export async function readSqlArtifactAuthority(scope: SqlArtifactAuthority) {
  const { project, policy } = await authorize(scope)
  return { ...policy, accountId: project.supabase_account_id, projectRef: project.supabase_project_ref }
}
export async function sqlArtifactStatus(scope: SqlArtifactAuthority) {
  if (await scope.verifyIdentity() !== scope.ownerId) throw new SqlArtifactError('Sessão não autorizada.', 401)
  await getProject(scope.ownerId, scope.projectId)
  const [entries, workers] = await Promise.all([
    scope.client.from('project_sql_artifacts').select('id,path,state,message,updated_at').eq('user_id', scope.ownerId).eq('project_id', scope.projectId).order('created_at', { ascending: false }).limit(20),
    scope.client.from('project_sql_executors').select('device_id').eq('user_id', scope.ownerId).eq('project_id', scope.projectId).eq('ready', true).gt('updated_at', new Date(Date.now() - 45_000).toISOString()).limit(1),
  ])
  if (entries.error || workers.error) throw new SqlArtifactError('Atualize as migrations do motor para usar alterações versionadas.', 503)
  const summaries: SqlArtifactSummary[] = (entries.data ?? []).map(row => sqlArtifactSchema.pick({ id: true, path: true, state: true, message: true, updatedAt: true }).parse({ id: row.id, path: row.path, state: row.state, message: row.message, updatedAt: row.updated_at }))
  return { executorAvailable: (workers.data?.length ?? 0) > 0, artifacts: summaries }
}
export async function prepareSqlArtifact(scope: SqlArtifactAuthority, raw: unknown) {
  const input = prepareSqlArtifactSchema.parse(raw)
  if (input.projectId !== scope.projectId || input.expectedRef !== scope.expectedRef) throw new SqlArtifactError('Projeto ou destino divergente.')
  validateAutomaticMigration(input.content)
  const { project } = await authorize(scope)
  const result = await scope.client.rpc('prepare_sql_artifact', { p_id: randomUUID(), p_owner: scope.ownerId, p_project: scope.projectId,
    p_ref: scope.expectedRef, p_account: project.supabase_account_id, p_content: input.content, p_digest: artifactDigest(input.content) })
  if (result.error || !Array.isArray(result.data) || !result.data[0]) throw new SqlArtifactError('Não foi possível preparar a migration; nenhum SQL aplicado.', 503)
  return sqlArtifactStatus(scope)
}
export async function pollSqlArtifact(scope: SqlArtifactAuthority, sessionId: string, ready: boolean): Promise<SqlArtifact | null> {
  if (!scope.deviceId) throw new SqlArtifactError('Executor não identificado.', 401)
  await authorize(scope)
  const presence = await scope.client.from('project_sql_executors').upsert({ project_id: scope.projectId, device_id: scope.deviceId,
    user_id: scope.ownerId, session_id: sessionId, ready, updated_at: new Date().toISOString() }, { onConflict: 'project_id,device_id' })
  if (presence.error) throw new SqlArtifactError('Presença do executor não confirmada.', 503)
  if (!ready) return null
  const result = await scope.client.rpc('claim_sql_artifact', { p_owner: scope.ownerId, p_project: scope.projectId, p_device: scope.deviceId, p_session: sessionId })
  if (result.error) throw new SqlArtifactError('Não foi possível reservar a migration.', 503)
  return Array.isArray(result.data) && result.data[0] ? artifact(result.data[0] as Record<string, unknown>) : null
}
export async function processSqlArtifact(scope: SqlArtifactAuthority, input: { id: string; claimToken: string; operation: 'materialized' | 'advance' | 'completed' | 'conflict'; digest?: string; typesDigest?: string }): Promise<SqlArtifact> {
  const target = await authorize(scope)
  const result = await scope.client.from('project_sql_artifacts').select('*').eq('id', input.id).eq('user_id', scope.ownerId).eq('project_id', scope.projectId)
    .eq('device_id', scope.deviceId ?? '').eq('claim_token', input.claimToken).gt('lease_expires_at', new Date().toISOString()).maybeSingle()
  if (result.error || !result.data) throw new SqlArtifactError('Posse da migration mudou; arquivo e banco preservados.')
  const account = z.string().uuid().nullable().parse(result.data.account_id)
  let current = artifact(result.data as Record<string, unknown>)
  if (current.projectRef !== scope.expectedRef || target.project.supabase_account_id !== account) throw new SqlArtifactError('Conta ou banco mudou desde a preparação.')
  let requireSchemaAuthority: (() => Promise<void>) | null = null
  const verify = async () => {
    const latest = await authorize(scope)
    if (latest.project.supabase_account_id !== account) throw new SqlArtifactError('Conta do banco mudou.')
    const lease = await scope.client.from('project_sql_artifacts').select('id').eq('id', current.id).eq('project_id', scope.projectId)
      .eq('user_id', scope.ownerId).eq('device_id', scope.deviceId ?? '').eq('claim_token', input.claimToken).gt('lease_expires_at', new Date().toISOString()).maybeSingle()
    if (lease.error || !lease.data) throw new SqlArtifactError('Executor perdeu a posse antes do próximo efeito.')
    if (requireSchemaAuthority) await requireSchemaAuthority()
    return { record: latest.record, linkedRef: latest.project.supabase_project_ref }
  }
  const save = async (state: SqlArtifact['state'], message: string, types?: NonNullable<SqlArtifact['types']>): Promise<SqlArtifact> => {
    const updated = await scope.client.from('project_sql_artifacts').update({ state, message, updated_at: new Date().toISOString(), lease_expires_at: new Date(Date.now() + 120_000).toISOString(),
      ...(types ? { types_content: types.content, types_digest: types.digest } : {}) })
      .eq('id', current.id).eq('project_id', scope.projectId).eq('user_id', scope.ownerId).eq('claim_token', input.claimToken)
      .eq('device_id', scope.deviceId ?? '').eq('state', current.state).gt('lease_expires_at', new Date().toISOString()).select('*').maybeSingle()
    if (updated.error || !updated.data) throw new SqlArtifactError('Recibo mudou durante a execução; reconcilie pelo ID.')
    current = artifact(updated.data as Record<string, unknown>); return current
  }
  if (input.operation === 'materialized') {
    assertMaterialization(current, input.digest ?? '')
    if (current.state === 'materialized') return current
    if (current.state !== 'materializing') throw new SqlArtifactError('Migration não está aguardando materialização.')
    return save('materialized', 'Arquivo e hash confirmados no projeto; aguardando aplicação autorizada.')
  }
  if (input.operation === 'completed') {
    if (current.state === 'succeeded') return current
    if (current.state !== 'applied' || !current.types || current.types.digest !== input.typesDigest) throw new SqlArtifactError('Tipos locais ainda não confirmados.')
    return save('succeeded', 'Migration aplicada, histórico confirmado e tipos gravados no projeto.')
  }
  if (input.operation === 'conflict') return save(current.state === 'applied' ? 'applied' : 'conflict', 'Arquivo local divergente; nenhum arquivo personalizado sobrescrito. Confira o ID e o histórico antes de continuar.')
  const management = async (suffix: string, sql?: string): Promise<unknown> => {
    await verify()
    const project = await getProject(scope.ownerId, scope.projectId), credentials = await getSupabaseCredentials(scope.ownerId, project)
    if (credentials.projectRef !== scope.expectedRef || project.supabase_account_id !== account) throw new SqlArtifactError('Credencial vinculada a outro destino.')
    await verify()
    const response = await fetch(`https://api.supabase.com/v1/projects/${scope.expectedRef}/${suffix}`, {
      method: sql ? 'POST' : 'GET', redirect: 'error', headers: { Authorization: `Bearer ${credentials.token}`, 'Content-Type': 'application/json' },
      ...(sql ? { body: JSON.stringify({ query: sql }) } : {}), signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) throw new SqlArtifactError('Fornecedor não confirmou o resultado; o ID permanece disponível para reconciliação.')
    return boundedJson(response, 2_100_000)
  }
  const store = backendOperationStore(scope.client, { ownerId: scope.ownerId, projectId: scope.projectId, id: current.id, capability: 'schema.migrate', input: { path: current.path, digest: current.digest, projectRef: current.projectRef } })
  requireSchemaAuthority = async () => {
    await authorizeProjectOperation({ ...scope, environment: 'development' }, 'schema.migrate', { resource: 'supabase/migrations' })
    await store.checkAuthorization()
  }
  return store.withAuthorizationContext(async () => {
    try { return await advanceSqlArtifact(current, {
    authorize: async () => { await verify() }, save,
    execute: async () => {
      const receipt = await runTrackedOperation({
        ...store,
        authorize: () => authorizeProjectOperation({ ...scope, environment: 'development' }, 'schema.migrate', { resource: 'supabase/migrations' }),
        execute: async () => ({ ...await runDatabaseOperation({ verify, query: (_ref, sql) => management('database/query', sql), configureAuth: async () => { throw new SqlArtifactError('Operação fora do contrato.') } }, scope.expectedRef, 'migrate', [{ path: current.path, content: current.content }]) }),
        verify: async () => true, // runDatabaseOperation commits SQL and exact history together; reconciliation below independently reads it.
      })
      return receipt.state === 'succeeded' ? 'succeeded' : receipt.state === 'failed' || receipt.state === 'cancelled' ? 'failed' : receipt.state === 'uncertain' ? 'uncertain' : 'pending'
    },
    history: async () => {
      const version = current.path.split('/').at(-1)!.split('_')[0]!
      const rows = z.array(z.object({ version: z.string(), statements: z.array(z.string()).nullable() })).parse(await management('database/query', `select version, statements from supabase_migrations.schema_migrations where version = '${version}';`))
      return !rows.length ? 'absent' : rows.length === 1 && rows[0]!.statements && artifactDigest(rows[0]!.statements.join('\n')) === current.digest ? 'matching' : 'conflict'
    },
    // Supabase Management API: /reference/api/v1-generate-typescript-types.
    types: async () => z.object({ types: z.string().min(1).max(2_000_000) }).parse(await management('types/typescript?included_schemas=public')).types,
    }) } catch (error) {
      // The refusal precedes the applying state and ledger claim, so the daemon
      // may check this same immutable ID after approval without replaying SQL.
      if (error instanceof OperationApprovalRequired && current.state === 'materialized') return save('materialized', error.message)
      throw error
    }
  })
}
