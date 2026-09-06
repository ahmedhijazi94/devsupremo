import type { SupabaseClient } from '@supabase/supabase-js'
import { validationFeedbackSchema, type ValidationFeedback, type FeedbackEnvelope } from './feedback'

export async function readCheckpointFeedback(client: SupabaseClient, projectId: string, checkpointId: string): Promise<ValidationFeedback | null> {
  const { data, error } = await client.from('checkpoints').select('validation_feedback')
    .eq('project_id', projectId).eq('id', checkpointId).maybeSingle()
  if (error) throw new Error('Não foi possível consultar o diagnóstico de validação.')
  const parsed = validationFeedbackSchema.safeParse(data?.validation_feedback)
  return parsed.success && parsed.data.projectId === projectId && parsed.data.checkpointId === checkpointId ? parsed.data : null
}

export async function saveCheckpointFeedback(client: SupabaseClient, feedback: ValidationFeedback): Promise<void> {
  const safe = validationFeedbackSchema.parse(feedback)
  // A late request cannot replace a newer observation, or write onto another SHA.
  const { error } = await client.from('checkpoints').update({ validation_feedback: safe,
    ...(safe.state === 'failed' ? { validation_failure: safe } : {}),
    ...(safe.state === 'passed' || safe.state === 'integrated' ? { validation_success: safe } : {}),
  })
    .eq('project_id', safe.projectId).eq('id', safe.checkpointId).eq('published_sha', safe.publishedSha)
    .or(`validation_feedback.is.null,validation_feedback->>observedAt.lt.${safe.observedAt}`)
  if (error) throw new Error('Não foi possível guardar o diagnóstico de validação.')
}

export async function readFeedbackEnvelope(client: SupabaseClient, projectId: string, checkpointId: string | null): Promise<FeedbackEnvelope> {
  const current = checkpointId ? await readCheckpointFeedback(client, projectId, checkpointId) : null
  if (current && current.state !== 'pending') return { current, previousFailure: null }
  const { data: successRow, error: successError } = await client.from('checkpoints').select('created_at, validation_success')
    .eq('project_id', projectId).not('validation_success', 'is', null)
    .order('created_at', { ascending: false }).limit(1).maybeSingle()
  if (successError) throw new Error('Não foi possível consultar a última recuperação confirmada.')
  const { data, error } = await client.from('checkpoints').select('created_at, validation_failure')
    .eq('project_id', projectId).not('validation_failure', 'is', null)
    .order('created_at', { ascending: false }).limit(1).maybeSingle()
  if (error) throw new Error('Não foi possível consultar pendências de validação.')
  const parsed = validationFeedbackSchema.safeParse(data?.validation_failure)
  const success = validationFeedbackSchema.safeParse(successRow?.validation_success)
  const resolved = success.success && success.data.projectId === projectId && data && successRow &&
    (data.created_at < successRow.created_at ||
      (data.created_at === successRow.created_at && parsed.success && parsed.data.observedAt <= success.data.observedAt))
  const previousFailure = parsed.success && parsed.data.projectId === projectId && !resolved ? parsed.data : null
  return { current, previousFailure }
}
