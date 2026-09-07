import type { SupabaseClient } from '@supabase/supabase-js'
import { sanitizeDiagnostic, validationFeedbackSchema, type ValidationFeedback, type FeedbackEnvelope } from './feedback'

function safeFeedback(feedback: ValidationFeedback): ValidationFeedback {
  return validationFeedbackSchema.parse({
    ...feedback,
    summary: sanitizeDiagnostic(feedback.summary).slice(0, 2000),
    evidence: sanitizeDiagnostic(feedback.evidence),
    failures: feedback.failures.map((failure) => ({ ...failure, name: sanitizeDiagnostic(failure.name).slice(0, 200) })),
    ...(feedback.checks ? { checks: feedback.checks.map((check) => ({ ...check, name: sanitizeDiagnostic(check.name).slice(0, 200) })) } : {}),
    ...(feedback.acceptance ? { acceptance: { ...feedback.acceptance,
      checks: feedback.acceptance.checks.map((check) => ({ ...check, name: sanitizeDiagnostic(check.name).slice(0, 200) })),
      criterionIds: feedback.acceptance.criterionIds.map((id) => sanitizeDiagnostic(id).slice(0, 100)),
    } } : {}),
  })
}

function feedbackFromRow(row: Record<string, unknown> | null, column: string, projectId: string): ValidationFeedback | null {
  if (row?.[column] == null) return null
  const parsed = validationFeedbackSchema.safeParse(row[column])
  if (!parsed.success || parsed.data.projectId !== projectId || parsed.data.checkpointId !== row.id ||
    parsed.data.commitSha !== row.commit_sha || parsed.data.publishedSha !== row.published_sha) {
    throw new Error('Diagnóstico não corresponde ao projeto, checkpoint ou SHA registrados.')
  }
  return safeFeedback(parsed.data)
}

export async function readCheckpointFeedback(client: SupabaseClient, projectId: string, checkpointId: string): Promise<ValidationFeedback | null> {
  const { data, error } = await client.from('checkpoints').select('id, commit_sha, published_sha, validation_feedback')
    .eq('project_id', projectId).eq('id', checkpointId).maybeSingle()
  if (error) throw new Error('Não foi possível consultar o diagnóstico de validação.')
  return feedbackFromRow(data, 'validation_feedback', projectId)
}

export async function saveCheckpointFeedback(client: SupabaseClient, feedback: ValidationFeedback): Promise<void> {
  const safe = safeFeedback(validationFeedbackSchema.parse(feedback))
  // A late request cannot replace a newer observation, or write onto another SHA.
  const { error } = await client.from('checkpoints').update({ validation_feedback: safe,
    ...(safe.state === 'failed' ? { validation_failure: safe } : {}),
    ...(safe.state === 'passed' || safe.state === 'integrated' ? { validation_success: safe } : {}),
  })
    .eq('project_id', safe.projectId).eq('id', safe.checkpointId).eq('commit_sha', safe.commitSha).eq('published_sha', safe.publishedSha)
    .or(`validation_feedback.is.null,validation_feedback->>observedAt.lt.${safe.observedAt}`)
  if (error) throw new Error('Não foi possível guardar o diagnóstico de validação.')
}

export async function readFeedbackEnvelope(client: SupabaseClient, projectId: string, checkpointId: string | null): Promise<FeedbackEnvelope> {
  const current = checkpointId ? await readCheckpointFeedback(client, projectId, checkpointId) : null
  if (current && current.state !== 'pending') return { current, previousFailure: null }
  const { data: successRow, error: successError } = await client.from('checkpoints').select('id, commit_sha, published_sha, created_at, validation_success')
    .eq('project_id', projectId).not('validation_success', 'is', null)
    .order('created_at', { ascending: false }).limit(1).maybeSingle()
  if (successError) throw new Error('Não foi possível consultar a última recuperação confirmada.')
  const { data, error } = await client.from('checkpoints').select('id, commit_sha, published_sha, created_at, validation_failure')
    .eq('project_id', projectId).not('validation_failure', 'is', null)
    .order('created_at', { ascending: false }).limit(1).maybeSingle()
  if (error) throw new Error('Não foi possível consultar pendências de validação.')
  const failure = feedbackFromRow(data, 'validation_failure', projectId)
  const success = feedbackFromRow(successRow, 'validation_success', projectId)
  if ((failure && failure.state !== 'failed') || (success && success.state !== 'passed' && success.state !== 'integrated')) {
    throw new Error('Estado do histórico de validação inválido.')
  }
  const resolved = success && data && successRow &&
    (data.created_at < successRow.created_at ||
      (data.created_at === successRow.created_at && failure && failure.observedAt <= success.observedAt))
  const previousFailure = failure && !resolved ? failure : null
  return { current, previousFailure }
}
