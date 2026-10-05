'use server'

import { requireProjectOwner, requireUser } from '@/lib/auth'
import { createServiceClient } from '@/lib/supabase/admin'
import { usageReadSchema, usageSettingsSchema, type UsageResult } from '@/lib/backend-observability/contract'
import { readAuthorizedUsage, saveAuthorizedUsageLimits } from '@/lib/backend-observability/server'
import { InspectionError } from '@/lib/database-inspection/provider'
import { OperationError } from '@/lib/backend-operations/contract'
const explanation = (error: unknown) => error instanceof OperationError || error instanceof InspectionError ? error.message : 'Não foi possível consultar o uso. Confira a sessão e o ambiente.'
async function authority(projectId: string) {
  const { user } = await requireProjectOwner(projectId, 'id,user_id')
  return { client: createServiceClient(), ownerId: user.id, projectId, ownerSession: true as const,
    verifyIdentity: async () => (await requireUser()).user.id, verifyOwnerSession: async () => (await requireUser()).user.id }
}
export async function getBackendUsage(raw: unknown): Promise<UsageResult> {
  try { const input = usageReadSchema.parse(raw); return { ok: true, report: await readAuthorizedUsage(await authority(input.projectId), input) } }
  catch (error) { return { ok: false, error: explanation(error) } }
}
export async function saveBackendUsageLimits(raw: unknown): Promise<{ ok: true } | { ok: false; error: string }> {
  try { const input = usageSettingsSchema.parse(raw); await saveAuthorizedUsageLimits(await authority(input.projectId), input); return { ok: true } }
  catch (error) { return { ok: false, error: explanation(error) } }
}
