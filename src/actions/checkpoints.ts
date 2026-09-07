'use server'

import { z } from 'zod'
import { requireUser, toActionError } from '@/lib/auth'
import { humanCheckpointStatus, humanRestoreStatus } from '@/lib/checkpoint/restore'
import { validationFeedbackSchema } from '@/lib/checkpoint/feedback'
import { localCheckpointPresentation } from '@/lib/checkpoint/local-report'

/**
 * Histórico + Restore (v3.1 finalização) — o usuário nunca precisa abrir o
 * GitHub para ver o que mudou ou voltar a um ponto anterior. Tudo aqui é
 * RLS-scoped pela sessão do usuário (nunca service_role): só enxerga/mexe nos
 * checkpoints do PRÓPRIO projeto.
 */

export interface CheckpointHistoryItem {
  id: string
  parentCheckpointId: string | null
  summary: string
  riskLevel: 'low' | 'medium' | 'high'
  status: ReturnType<typeof humanCheckpointStatus>
  migrations: string[]
  prNumber: number | null
  createdAt: string
  restoredFromCheckpointId: string | null
  validationLabel?: string
  validationSummary?: string
  canRestore?: boolean
  localState?: 'pending' | 'failed'
}

export async function listProjectCheckpoints(
  projectId: string,
): Promise<{ items?: CheckpointHistoryItem[]; error?: string }> {
  if (!z.string().uuid().safeParse(projectId).success) return { error: 'ID inválido.' }
  try {
    const { supabase } = await requireUser()
    // RLS (checkpoints_owner_select) já filtra pelo dono; o filtro explícito
    // de project_id evita depender só da policy.
    const { data, error } = await supabase
      .from('checkpoints')
      .select(
        'id, parent_checkpoint_id, summary, risk_level, push_status, integration_status, migrations, pr_number, created_at, restored_from_checkpoint_id, project_id, validation_feedback, published_sha, local_validation_status, local_upload_status',
      )
      .eq('project_id', projectId)
      .order('created_at', { ascending: false })
      .limit(50)
    if (error) return { error: error.message }
    return {
      items: (data ?? []).map((r, index, rows) => ({
        id: r.id as string,
        parentCheckpointId: (r.parent_checkpoint_id as string | null) ?? null,
        summary: r.summary as string,
        riskLevel: r.risk_level as CheckpointHistoryItem['riskLevel'],
        status: humanCheckpointStatus(
          r.push_status as Parameters<typeof humanCheckpointStatus>[0],
          r.integration_status as Parameters<typeof humanCheckpointStatus>[1],
        ),
        migrations: Array.isArray(r.migrations) ? (r.migrations as string[]) : [],
        prNumber: (r.pr_number as number | null) ?? null,
        createdAt: r.created_at as string,
        restoredFromCheckpointId: (r.restored_from_checkpoint_id as string | null) ?? null,
        canRestore: ['published', 'integrated'].includes(r.push_status as string) && typeof r.published_sha === 'string',
        ...(r.push_status === 'local' ? { localState: localCheckpointPresentation(r.local_validation_status, r.local_upload_status).state } : {}),
        validationLabel: r.push_status === 'local'
          ? localCheckpointPresentation(r.local_validation_status, r.local_upload_status).label
          : r.push_status === 'published' && (r.integration_status === 'ci_failed' || r.integration_status === 'security_blocked')
          ? rows.slice(0, index).some((newer) => newer.pr_number === r.pr_number)
            ? 'Aguarda correção do conjunto' : 'Validação bloqueada'
          : '',
        validationSummary: r.push_status === 'local'
          ? localCheckpointPresentation(r.local_validation_status, r.local_upload_status).summary
          : validationFeedbackSchema.safeParse(r.validation_feedback).success
          ? validationFeedbackSchema.parse(r.validation_feedback).summary : '',
      })),
    }
  } catch (error) {
    return { error: toActionError(error) }
  }
}

export interface RestoreRequestView {
  id: string
  targetCheckpointId: string
  status: ReturnType<typeof humanRestoreStatus>
  resultCheckpointId: string | null
  error: string | null
  createdAt: string
}

export async function listProjectRestoreRequests(
  projectId: string,
): Promise<{ items?: RestoreRequestView[]; error?: string }> {
  if (!z.string().uuid().safeParse(projectId).success) return { error: 'ID inválido.' }
  try {
    const { supabase } = await requireUser()
    const { data, error } = await supabase
      .from('checkpoint_restore_requests')
      .select('id, target_checkpoint_id, status, result_checkpoint_id, error, created_at')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false })
    if (error) return { error: error.message }
    return {
      items: (data ?? []).map((r) => ({
        id: r.id as string,
        targetCheckpointId: r.target_checkpoint_id as string,
        status: humanRestoreStatus(r.status as 'pending' | 'claimed' | 'applied' | 'failed'),
        resultCheckpointId: (r.result_checkpoint_id as string | null) ?? null,
        error: (r.error as string | null) ?? null,
        createdAt: r.created_at as string,
      })),
    }
  } catch (error) {
    return { error: toActionError(error) }
  }
}

/**
 * Cria o pedido de "Restaurar X". NÃO aplica nada aqui — o daemon da máquina
 * original consome o pedido (poll), aplica localmente (patch + novo checkpoint)
 * e reporta. RLS garante que só o dono do projeto pede restore, e só de um
 * checkpoint do PRÓPRIO projeto.
 */
export async function requestCheckpointRestore(
  projectId: string,
  targetCheckpointId: string,
): Promise<{ ok?: true; error?: string }> {
  if (
    !z.string().uuid().safeParse(projectId).success ||
    !z.string().uuid().safeParse(targetCheckpointId).success
  ) {
    return { error: 'ID inválido.' }
  }
  try {
    const { user, supabase } = await requireUser()
    const { data: target, error: targetError } = await supabase.from('checkpoints')
      .select('id, published_sha, push_status').eq('id', targetCheckpointId).eq('project_id', projectId).maybeSingle()
    if (targetError || !target || !['published', 'integrated'].includes(target.push_status as string) || !target.published_sha) {
      return { error: 'Este checkpoint ainda não está disponível para restauração.' }
    }
    const { error } = await supabase.from('checkpoint_restore_requests').insert({
      project_id: projectId,
      target_checkpoint_id: targetCheckpointId,
      requested_by: user.id,
    })
    if (error) return { error: error.message }
    return { ok: true }
  } catch (error) {
    return { error: toActionError(error) }
  }
}
