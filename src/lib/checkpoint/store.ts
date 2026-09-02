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
}

/** Grava/atualiza a metadata do checkpoint (idempotente por id). */
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
    },
    { onConflict: 'id' },
  )
  if (error) throw new Error(`Falha ao gravar checkpoint: ${error.message}`)
}

export async function setCheckpointPushStatus(
  client: SupabaseClient,
  id: string,
  status: 'pushing' | 'pushed' | 'integrated' | 'push_failed',
  extra?: { prNumber?: number; integrationBranch?: string; integrationStatus?: string },
): Promise<void> {
  await client
    .from('checkpoints')
    .update({
      push_status: status,
      ...(extra?.prNumber != null ? { pr_number: extra.prNumber } : {}),
      ...(extra?.integrationBranch ? { integration_branch: extra.integrationBranch } : {}),
      ...(extra?.integrationStatus ? { integration_status: extra.integrationStatus } : {}),
    })
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
