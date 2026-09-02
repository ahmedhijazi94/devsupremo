import type { SupabaseClient } from '@supabase/supabase-js'
import type { CheckpointDeviceRow, CheckpointDeviceStore } from './devices'

/**
 * Adapters Supabase (service_role) do checkpoint daemon — I/O puro sobre
 * `checkpoint_devices` e `checkpoints`. A LÓGICA (gerar/hash/validar secret,
 * autorizar grant, planejar integração) vive nos módulos PUROS já testados;
 * aqui só traduzimos para queries. Por ser adapter de I/O, fica fora da métrica
 * de unit coverage (ver vitest.config.ts) — cobertura real vem do E2E.
 */

export function supabaseCheckpointDeviceStore(
  client: SupabaseClient,
): CheckpointDeviceStore {
  return {
    async create(input) {
      const { data, error } = await client
        .from('checkpoint_devices')
        .insert({
          owner_user_id: input.ownerUserId,
          secret_hash: input.secretHash,
          device_label: input.label,
        })
        .select('id')
        .single()
      if (error || !data) {
        throw new Error(`Falha ao registrar device: ${error?.message ?? '??'}`)
      }
      return { id: data.id as string }
    },

    async findBySecretHash(secretHash): Promise<CheckpointDeviceRow | null> {
      const { data, error } = await client
        .from('checkpoint_devices')
        .select('id, owner_user_id, device_label, revoked_at')
        .eq('secret_hash', secretHash)
        .maybeSingle()
      if (error || !data) return null
      return {
        id: data.id as string,
        ownerUserId: data.owner_user_id as string,
        label: (data.device_label as string | null) ?? null,
        revokedAt: (data.revoked_at as string | null) ?? null,
      }
    },

    async touch(id, nowIso) {
      await client
        .from('checkpoint_devices')
        .update({ last_seen_at: nowIso })
        .eq('id', id)
    },

    async revoke(id, ownerUserId, nowIso) {
      await client
        .from('checkpoint_devices')
        .update({ revoked_at: nowIso })
        .eq('id', id)
        .eq('owner_user_id', ownerUserId)
    },
  }
}

// ── Persistência de checkpoints (metadata + estado de push) ──────────────────

export interface CheckpointUpsert {
  id: string
  projectId: string
  deviceId: string
  commitSha: string
  parentCheckpointId: string | null
  summary: string
  riskLevel: 'low' | 'medium' | 'high'
  migrations: string[]
  /** Metadata de origem (Histórico), quando o host do agente fornecer. */
  conversationId?: string | null | undefined
  messageId?: string | null | undefined
  originAgent?: string | null | undefined
  /** Presente quando este checkpoint é o "E" resultante de um restore. */
  restoredFromCheckpointId?: string | null | undefined
}

/** Estado do checkpoint (para idempotência do publish). */
export interface CheckpointStateRow {
  id: string
  pushStatus: string
  prNumber: number | null
  integrationBranch: string | null
  publishedSha: string | null
}

/** Lê o estado de um checkpoint (idempotência: já publicado?). */
export async function getCheckpointState(
  client: SupabaseClient,
  id: string,
): Promise<CheckpointStateRow | null> {
  const { data } = await client
    .from('checkpoints')
    .select('id, push_status, pr_number, integration_branch, published_sha')
    .eq('id', id)
    .maybeSingle()
  if (!data) return null
  return {
    id: data.id as string,
    pushStatus: data.push_status as string,
    prNumber: (data.pr_number as number | null) ?? null,
    integrationBranch: (data.integration_branch as string | null) ?? null,
    publishedSha: (data.published_sha as string | null) ?? null,
  }
}

/** Cria/atualiza a metadata do checkpoint em estado 'publishing' (idempotente). */
export async function upsertCheckpoint(
  client: SupabaseClient,
  input: CheckpointUpsert,
): Promise<void> {
  const { error } = await client.from('checkpoints').upsert(
    {
      id: input.id,
      project_id: input.projectId,
      device_id: input.deviceId,
      commit_sha: input.commitSha,
      parent_checkpoint_id: input.parentCheckpointId,
      summary: input.summary,
      risk_level: input.riskLevel,
      migrations: input.migrations,
      push_status: 'publishing',
      ...(input.conversationId ? { conversation_id: input.conversationId } : {}),
      ...(input.messageId ? { message_id: input.messageId } : {}),
      ...(input.originAgent ? { origin_agent: input.originAgent } : {}),
      ...(input.restoredFromCheckpointId
        ? { restored_from_checkpoint_id: input.restoredFromCheckpointId }
        : {}),
    },
    { onConflict: 'id' },
  )
  if (error) throw new Error(`Falha ao gravar checkpoint: ${error.message}`)
}

export async function setCheckpointPushStatus(
  client: SupabaseClient,
  id: string,
  status: 'publishing' | 'published' | 'integrated' | 'failed',
  extra?: {
    prNumber?: number
    integrationBranch?: string
    integrationStatus?: string
    publishedSha?: string
  },
): Promise<void> {
  await client
    .from('checkpoints')
    .update({
      push_status: status,
      ...(extra?.prNumber != null ? { pr_number: extra.prNumber } : {}),
      ...(extra?.integrationBranch ? { integration_branch: extra.integrationBranch } : {}),
      ...(extra?.integrationStatus ? { integration_status: extra.integrationStatus } : {}),
      ...(extra?.publishedSha ? { published_sha: extra.publishedSha } : {}),
    })
    .eq('id', id)
}

// ── Restore (v3.1 finalização) ───────────────────────────────────────────────

export interface RestoreRequestRow {
  id: string
  projectId: string
  targetCheckpointId: string
  status: 'pending' | 'claimed' | 'applied' | 'failed'
}

/** Checkpoint mínimo para autorizar/aplicar o restore (commit local + resumo). */
export async function getCheckpointForRestore(
  client: SupabaseClient,
  id: string,
): Promise<{ id: string; projectId: string; commitSha: string; summary: string } | null> {
  const { data } = await client
    .from('checkpoints')
    .select('id, project_id, commit_sha, summary')
    .eq('id', id)
    .maybeSingle()
  if (!data) return null
  return {
    id: data.id as string,
    projectId: data.project_id as string,
    commitSha: data.commit_sha as string,
    summary: data.summary as string,
  }
}

/**
 * Dono do projeto de um pedido de restore (join restore_request → project) —
 * usado por /restore-report para confirmar que o device autenticado só fecha
 * pedidos do PRÓPRIO dono (ver `authorizeRestoreReport`, fail-closed contra
 * IDOR). null quando o pedido não existe.
 */
export async function getRestoreRequestProjectOwner(
  client: SupabaseClient,
  restoreRequestId: string,
): Promise<{ projectOwnerUserId: string } | null> {
  const { data: req } = await client
    .from('checkpoint_restore_requests')
    .select('project_id')
    .eq('id', restoreRequestId)
    .maybeSingle()
  if (!req) return null
  const { data: proj } = await client
    .from('projects')
    .select('user_id')
    .eq('id', req.project_id as string)
    .maybeSingle()
  if (!proj) return null
  return { projectOwnerUserId: proj.user_id as string }
}

/**
 * Reivindica (poll-and-claim atômico) os pedidos PENDENTES de um projeto para
 * este device — evita dois daemons aplicarem o mesmo restore. `pending → claimed`
 * só se ainda pending (condição no UPDATE); devolve só os que este device pegou.
 */
export async function claimPendingRestoreRequests(
  client: SupabaseClient,
  input: { projectId: string; deviceId: string },
): Promise<RestoreRequestRow[]> {
  const { data: pending } = await client
    .from('checkpoint_restore_requests')
    .select('id')
    .eq('project_id', input.projectId)
    .eq('status', 'pending')
  const ids = (pending ?? []).map((r) => r.id as string)
  if (ids.length === 0) return []

  const { data: claimed } = await client
    .from('checkpoint_restore_requests')
    .update({ status: 'claimed', device_id: input.deviceId })
    .in('id', ids)
    .eq('status', 'pending') // corrida: só quem ainda está pending é reivindicado
    .select('id, project_id, target_checkpoint_id, status')
  return (claimed ?? []).map((r) => ({
    id: r.id as string,
    projectId: r.project_id as string,
    targetCheckpointId: r.target_checkpoint_id as string,
    status: r.status as RestoreRequestRow['status'],
  }))
}

export async function reportRestoreApplied(
  client: SupabaseClient,
  id: string,
  resultCheckpointId: string | null,
): Promise<void> {
  await client
    .from('checkpoint_restore_requests')
    .update({ status: 'applied', result_checkpoint_id: resultCheckpointId, error: null })
    .eq('id', id)
}

export async function reportRestoreFailed(
  client: SupabaseClient,
  id: string,
  error: string,
): Promise<void> {
  await client
    .from('checkpoint_restore_requests')
    .update({ status: 'failed', error })
    .eq('id', id)
}

/** repository_id do projeto (backfill lazy quando resolvido no primeiro grant). */
export async function backfillRepositoryId(
  client: SupabaseClient,
  projectId: string,
  repositoryId: number,
): Promise<void> {
  if (!repositoryId) return
  await client
    .from('projects')
    .update({ github_repo_id: repositoryId })
    .eq('id', projectId)
    .is('github_repo_id', null)
}
