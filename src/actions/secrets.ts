'use server'

import { z } from 'zod'
import { requireProjectOwner } from '@/lib/auth'
import { createServiceClient } from '@/lib/supabase/admin'
import { dismissSecretSchema, saveSecretSchema, safeSecretFailure } from '@/lib/secret-requests/policy'
import { secretRequestStore } from '@/lib/secret-requests/store'
import { dismissRequestedSecret, fulfillSecret, listSecretRequests } from '@/lib/secret-requests/service'
import type { SecretRequestErrorCode, SecretRequestView } from '@/lib/secret-requests/policy'
export type { SecretRequestView } from '@/lib/secret-requests/policy'

export async function getSecretRequests(projectId: string): Promise<{ requests?: SecretRequestView[]; error?: string; errorCode?: SecretRequestErrorCode }> {
  if (!z.string().uuid().safeParse(projectId).success) return { error: 'ID inválido.' }
  try {
    const { user, supabase } = await requireProjectOwner(projectId, 'id,user_id')
    return { requests: await listSecretRequests(secretRequestStore(supabase, user.id, projectId)) }
  } catch (error) { return safeSecretFailure(error) }
}

/** Only the project owner can submit a value, through this form action. The destination is loaded by request ID. */
export async function saveSecret(input: { projectId: string; requestId: string; value: string }): Promise<{ ok?: true; error?: string; errorCode?: SecretRequestErrorCode }> {
  const parsed = saveSecretSchema.safeParse(input)
  if (!parsed.success) return { error: 'Dados inválidos.' }
  try {
    const { user } = await requireProjectOwner(parsed.data.projectId, 'id,user_id')
    // Only the backend can attest delivery. The store rechecks project ownership
    // before resolving the immutable request and provider account.
    await fulfillSecret(secretRequestStore(createServiceClient(), user.id, parsed.data.projectId), parsed.data.requestId, parsed.data.value)
    return { ok: true }
  } catch (error) { return safeSecretFailure(error) }
}

export async function dismissSecretRequest(input: { projectId: string; requestId: string }): Promise<{ ok?: true; error?: string; errorCode?: SecretRequestErrorCode }> {
  const parsed = dismissSecretSchema.safeParse(input)
  if (!parsed.success) return { error: 'Dados inválidos.' }
  try {
    const { user, supabase } = await requireProjectOwner(parsed.data.projectId, 'id,user_id')
    await dismissRequestedSecret(secretRequestStore(supabase, user.id, parsed.data.projectId), parsed.data.requestId)
    return { ok: true }
  } catch (error) { return safeSecretFailure(error) }
}
