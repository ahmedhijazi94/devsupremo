import type { SupabaseClient } from '@supabase/supabase-js'
import type { GithubCredentials } from '@/lib/projects/repository'
import { getChecks, getFailedJobLogs, getPullRequest } from '@/lib/github/client'
import { resolveRequiredChecks } from '@/lib/github/reconcile'
import { buildValidationFeedback, withFeedbackEvidence } from './feedback'
import { saveCheckpointFeedback } from './feedback-store'

/** Webhook and cron save evidence even while every local machine is offline. */
export async function capturePrFeedback(client: SupabaseClient, projectId: string, creds: GithubCredentials, prNumber: number): Promise<void> {
  const observedAt = new Date().toISOString()
  const pr = await getPullRequest(creds, prNumber)
  const { data, error } = await client.from('checkpoints').select('id, commit_sha, published_sha')
    .eq('project_id', projectId).eq('pr_number', prNumber).eq('published_sha', pr.headSha)
    .order('created_at', { ascending: false }).limit(1).maybeSingle()
  if (error) throw new Error('Falha ao localizar versão do diagnóstico.')
  if (!data) return
  const checks = await getChecks(creds, pr.headSha)
  let feedback = buildValidationFeedback({
    projectId, checkpointId: data.id as string, commitSha: data.commit_sha as string,
    publishedSha: pr.headSha, observedAt, checksSha: checks.headSha, checks: checks.checks,
    required: resolveRequiredChecks({}), integrated: pr.merged, evidence: '',
  })
  if (feedback.state === 'failed') {
    try {
      feedback = withFeedbackEvidence(feedback, await getFailedJobLogs(creds, pr.headSha, 8000))
    } catch {
      feedback.evidence = 'Log detalhado indisponível. Os gates identificados falharam; nova consulta automática em background.'
    }
  }
  await saveCheckpointFeedback(client, feedback)
}
