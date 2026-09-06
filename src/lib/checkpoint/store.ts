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
  commitSha: string
  pushStatus: string
  prNumber: number | null
  integrationBranch: string | null
  publishedSha: string | null
}

/** Lê o estado de um checkpoint (idempotência: já publicado?). */
export async function getCheckpointState(
  client: SupabaseClient,
  id: string,
  projectId: string,
): Promise<CheckpointStateRow | null> {
  const { data, error } = await client
    .from('checkpoints')
    .select('id, commit_sha, push_status, pr_number, integration_branch, published_sha')
    .eq('id', id)
    .eq('project_id', projectId)
    .maybeSingle()
  if (error) throw new Error(`Falha ao ler checkpoint: ${error.message}`)
  if (!data) return null
  return {
    id: data.id as string,
    commitSha: data.commit_sha as string,
    pushStatus: data.push_status as string,
    prNumber: (data.pr_number as number | null) ?? null,
    integrationBranch: (data.integration_branch as string | null) ?? null,
    publishedSha: (data.published_sha as string | null) ?? null,
  }
}

/** O checkpoint mais recente REALMENTE conhecido de um projeto (v3.3 —
 * sincronização entre máquinas): a "verdade" que tanto o publish (proteção
 * cross-machine, ver `baseCheckpointIsFresh`) quanto a checagem leve de sync
 * de sessão (`/api/checkpoint/sync-status`) consultam. */
export interface LatestCheckpointRow {
  id: string
  createdAt: string
  commitSha: string
  summary: string
  pushStatus: string
  integrationStatus: string | null
  prNumber: number | null
  /** Branch de integração REAL já gerenciada pelo Supremo (Git Data API) —
   * existe assim que `pushStatus` chega a 'published'. Continuidade de
   * edição entre máquinas usa ISSO como base válida mesmo com PR/CI ainda
   * rodando (CI segue obrigatório só pra MERGE em `main`; ver sync.ts). */
  integrationBranch: string | null
  /** SHA EXATO que este checkpoint produziu em `integrationBranch` (Git Data
   * API, gravado no publish — `applied.commitSha` em publish/route.ts;
   * coluna JÁ EXISTENTE, não uma nova). `commitSha` acima é o commit LOCAL
   * da máquina de origem; este é o resultado real no remoto — só ele é
   * seguro pra pinar o fast-forward: `integrationBranch` pode ganhar um
   * checkpoint NOVO de outra máquina entre a consulta e o fetch (a branch
   * ainda está aberta/PR em andamento), então seguir o TIP da branch corre
   * o risco de pousar num commit mais novo que o cliente nunca confirmou.
   * Pinar neste SHA garante que o merge `--ff-only` só pode pousar EXATAMENTE
   * no checkpoint que o cliente pediu — nunca em "o que quer que esteja lá
   * agora" (ver `sync.ts`). `null` enquanto ainda 'publishing'. */
  publishedSha: string | null
}

/**
 * Mais recente entre `publishing`/`published`/`integrated` (mesmo filtro já
 * usado pelo publish pra achar a branch de integração corrente — reaproveitado
 * aqui, não uma query nova do zero). `'failed'` nunca conta como "o estado
 * atual" — não chegou a mudar nada de verdade. `excludeCheckpointId` evita que
 * um reenvio idempotente do PRÓPRIO checkpoint se veja como "outra máquina
 * publicou antes de mim".
 */
export async function getLatestKnownCheckpoint(
  client: SupabaseClient,
  projectId: string,
  excludeCheckpointId?: string,
): Promise<LatestCheckpointRow | null> {
  let query = client
    .from('checkpoints')
    .select(
      'id, created_at, commit_sha, summary, push_status, integration_status, pr_number, integration_branch, published_sha',
    )
    .eq('project_id', projectId)
    .in('push_status', ['publishing', 'published', 'integrated'])
  if (excludeCheckpointId) query = query.neq('id', excludeCheckpointId)
  const { data, error } = await query.order('created_at', { ascending: false }).limit(1).maybeSingle()
  if (error) throw new Error('Não foi possível verificar o checkpoint mais recente.')
  if (!data) return null
  return {
    id: data.id as string,
    createdAt: data.created_at as string,
    commitSha: data.commit_sha as string,
    summary: data.summary as string,
    pushStatus: data.push_status as string,
    integrationStatus: (data.integration_status as string | null) ?? null,
    prNumber: (data.pr_number as number | null) ?? null,
    integrationBranch: (data.integration_branch as string | null) ?? null,
    publishedSha: (data.published_sha as string | null) ?? null,
  }
}

export class CheckpointProjectConflictError extends Error {}

/** Cria/atualiza a metadata do checkpoint em estado 'publishing' (idempotente). */
export async function upsertCheckpoint(
  client: SupabaseClient,
  input: CheckpointUpsert,
): Promise<void> {
  const payload = {
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
    }
  // Um ID recebido do dispositivo nunca pode reassociar uma linha existente.
  // INSERT ON CONFLICT DO NOTHING fecha inclusive a corrida entre dois donos.
  const { error: insertError } = await client.from('checkpoints').upsert(
    payload, { onConflict: 'id', ignoreDuplicates: true },
  )
  if (insertError) throw new Error(`Falha ao gravar checkpoint: ${insertError.message}`)
  const { data, error } = await client.from('checkpoints')
    .update(payload)
    .eq('id', input.id)
    .eq('project_id', input.projectId)
    .eq('commit_sha', input.commitSha)
    .select('id')
    .maybeSingle()
  if (error) throw new Error(`Falha ao gravar checkpoint: ${error.message}`)
  if (!data) throw new CheckpointProjectConflictError('Checkpoint não pertence ao projeto autorizado ou identifica outro SHA.')
}

export async function setCheckpointPushStatus(
  client: SupabaseClient,
  id: string,
  projectId: string,
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
    .eq('project_id', projectId)
}

/**
 * Resultados sem merge só atualizam o published_sha observado: um resultado
 * atrasado de A não marca B, ainda que ambos compartilhem projeto e PR.
 * Merge confirmado integra todos os checkpoints publicados daquela PR, pois
 * o HEAD mesclado inclui os ancestrais. SHAs e ordem permanecem imutáveis.
 * Checkpoints integrated/failed/publishing e outras PRs nunca são alterados.
 * Erros de persistência propagam para o worker registrar e retentar.
 */
export async function reconcileCheckpointsForPr(
  client: SupabaseClient,
  input: { projectId: string; prNumber: number; publishedSha?: string },
  status: { pushStatus: 'integrated' | null; integrationStatus: string },
): Promise<void> {
  if (!status.pushStatus && !input.publishedSha) {
    throw new Error('Reconciliação sem merge exige o SHA observado para associar a validação.')
  }
  let query = client
    .from('checkpoints')
    .update({
      integration_status: status.integrationStatus,
      ...(status.pushStatus ? { push_status: status.pushStatus } : {}),
    })
    .eq('project_id', input.projectId)
    .eq('pr_number', input.prNumber)
    .eq('push_status', 'published')
  if (!status.pushStatus) query = query.eq('published_sha', input.publishedSha!)
  const { error } = await query
  if (error) {
    throw new Error(`Falha ao reconciliar checkpoints da PR #${input.prNumber}: ${error.message}`)
  }
}

export interface PendingBranchCleanup {
  projectId: string
  prNumber: number
  integrationBranch: string
}

/**
 * Candidatos ao fallback RETENTAR o cleanup de integration branch (v3-14):
 * checkpoints cuja PR já foi confirmada `integrated`/`merged` E que ainda
 * têm uma `integration_branch` registrada — o cleanup pode ter falhado
 * (rede/rate-limit do GitHub) sem deixar nenhum outro rastro de "pendente".
 *
 * BUG REAL: uma vez que `push_status` vira `'integrated'`, o PROJETO sai de
 * `RECONCILABLE_STATES` (webhook/reconcile) e a PR, já fechada, não aparece
 * mais em `getOpenPullRequestNumber` — nada no fallback periódico voltava a
 * visitar essa PR pra retentar um cleanup que falhou. Esta consulta reabre
 * exatamente essa porta, reaproveitando dados que `reconcileCheckpointsForPr`
 * já grava (nenhuma coluna nova, nenhuma migration).
 *
 * Deduplicado por (project_id, pr_number) em memória — 2+ checkpoints da
 * MESMA PR (reuse/synchronize, ver v3-8) não geram 2 tentativas de cleanup
 * na mesma varredura. `limit` (default 200, mesmo teto de
 * `listProjectsForReconcile`) mantém a varredura limitada: uma vez que o
 * cleanup de fato funciona (branch some), o próximo ciclo do fallback nem
 * precisa mais achar essa PR entre os `created_at` mais recentes — best-
 * effort, não uma fila que precisa de baixa/ack explícito.
 */
export async function listPendingIntegrationBranchCleanups(
  client: SupabaseClient,
  limit = 200,
): Promise<PendingBranchCleanup[]> {
  const { data, error } = await client
    .from('checkpoints')
    .select('project_id, pr_number, integration_branch, created_at')
    .eq('push_status', 'integrated')
    .eq('integration_status', 'merged')
    .not('integration_branch', 'is', null)
    .not('pr_number', 'is', null)
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error || !data) return []

  const seen = new Set<string>()
  const out: PendingBranchCleanup[] = []
  for (const row of data as Array<Record<string, unknown>>) {
    const projectId = row.project_id as string
    const prNumber = row.pr_number as number
    const integrationBranch = row.integration_branch as string
    const key = `${projectId}:${prNumber}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ projectId, prNumber, integrationBranch })
  }
  return out
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
