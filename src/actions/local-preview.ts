'use server'

import { z } from 'zod'
import { requireProjectOwner, toActionError } from '@/lib/auth'
import { broadcastCommand } from '@/lib/runtime/realtime-broadcast'

/**
 * Gatilhos do preview local: o navegador chama estas actions; o SERVIDOR (aqui)
 * valida a posse do projeto e só então transmite o comando ao companion pelo
 * Realtime. O frontend NUNCA publica comando direto — "comando privilegiado vem
 * pelo Supremo validado". Nenhum comando carrega segredo (o companion busca a
 * credencial de git por endpoint autenticado).
 */

const PROJECT_COLUMNS =
  'id, user_id, github_repo_full_name, default_branch, active_branch'

export async function startLocalPreview(
  projectId: string,
): Promise<{ ok?: true; error?: string }> {
  if (!z.string().uuid().safeParse(projectId).success) {
    return { error: 'ID inválido.' }
  }
  try {
    const { user, project } = await requireProjectOwner(projectId, PROJECT_COLUMNS)
    const repoFullName = project.github_repo_full_name as string | null
    if (!repoFullName) return { error: 'Projeto ainda não provisionado no GitHub.' }
    const branch =
      (project.active_branch as string | null) ??
      (project.default_branch as string | null) ??
      'main'

    await broadcastCommand(user.id, {
      type: 'start_project',
      projectId,
      repoFullName,
      branch,
    })
    return { ok: true }
  } catch (error) {
    return { error: toActionError(error) }
  }
}

export async function stopLocalPreview(
  projectId: string,
): Promise<{ ok?: true; error?: string }> {
  if (!z.string().uuid().safeParse(projectId).success) {
    return { error: 'ID inválido.' }
  }
  try {
    const { user } = await requireProjectOwner(projectId, 'id, user_id')
    await broadcastCommand(user.id, { type: 'stop_project', projectId })
    return { ok: true }
  } catch (error) {
    return { error: toActionError(error) }
  }
}

export async function applyLocalEdits(input: {
  projectId: string
  edits: Array<{ path: string; content: string | null }>
}): Promise<{ ok?: true; error?: string }> {
  const parsed = z
    .object({
      projectId: z.string().uuid(),
      edits: z
        .array(z.object({ path: z.string().min(1), content: z.string().nullable() }))
        .min(1),
    })
    .safeParse(input)
  if (!parsed.success) return { error: 'Dados inválidos.' }

  try {
    const { user } = await requireProjectOwner(parsed.data.projectId, 'id, user_id')
    await broadcastCommand(user.id, {
      type: 'apply_edits',
      projectId: parsed.data.projectId,
      edits: parsed.data.edits,
    })
    return { ok: true }
  } catch (error) {
    return { error: toActionError(error) }
  }
}
