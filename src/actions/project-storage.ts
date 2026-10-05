'use server'
import { z } from 'zod'
import { requireUser } from '@/lib/auth'
import { createServiceClient } from '@/lib/supabase/admin'
import { storageOptionsSchema } from '@/lib/project-storage/contract'
import { runAuthorizedStorage } from '@/lib/project-storage/server'
import { OperationError } from '@/lib/backend-operations/contract'

export async function manageProjectStorage(raw: unknown): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; error: string }> {
  const parsed = z.object({ projectId: z.string().uuid(), options: storageOptionsSchema }).strict().safeParse(raw)
  if (!parsed.success) return { ok: false, error: 'Confira o espaço, o arquivo e os limites da operação.' }
  try {
    const { user } = await requireUser()
    const data = await runAuthorizedStorage({ client: createServiceClient(), ownerId: user.id, ownerSession: true as const, projectId: parsed.data.projectId, verifyIdentity: async () => (await requireUser()).user.id }, parsed.data.options)
    return { ok: true, data }
  } catch (error) { return { ok: false, error: error instanceof OperationError ? error.message : 'Não foi possível confirmar a operação de armazenamento.' } }
}
