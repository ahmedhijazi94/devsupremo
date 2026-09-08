import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/admin'
import { authenticateDeviceSecret } from '@/lib/checkpoint/devices'
import { getLatestKnownCheckpoint, reconcileCheckpointsForPr, supabaseCheckpointDeviceStore, type LatestCheckpointRow } from '@/lib/checkpoint/store'
import { readCheckpointFeedback, readFeedbackEnvelope, saveCheckpointFeedback } from '@/lib/checkpoint/feedback-store'
import { buildValidationFeedback, withFeedbackEvidence } from '@/lib/checkpoint/feedback'
import { getProject, getGithubCredentials, NotFoundError, readIntegrationMeta, writeIntegrationMeta, type ProjectRecord } from '@/lib/projects/repository'
import { getChecks, getFailedJobLogs } from '@/lib/github/client'
import { checkpointStatusFromReconcile, reconcileProjectPr, resolveRequiredChecks } from '@/lib/github/reconcile'
import { getAcceptanceEvidence } from '@/lib/github/acceptance'
import { appTokenForRepo, installationCreds } from '@/lib/github/app'
import { githubMergeGateway } from '@/lib/github/gateway'
import { isSupremoIntegrationRef } from '@/lib/github/webhook'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60
const schema = z.object({ deviceSecret: z.string().min(10).max(256), projectId: z.string().uuid() }).strict()

/** A daemon heartbeat retries lost/transient integration events; it does not
 * confer approval. The common controller still requires the trusted workflow,
 * independent policy, CodeQL and the configured native protections. */
async function retryIntegration(client: SupabaseClient, project: ProjectRecord, latest: LatestCheckpointRow): Promise<boolean> {
  if (latest.pushStatus !== 'published' || !latest.publishedSha || !latest.prNumber ||
    !latest.integrationBranch || !isSupremoIntegrationRef(latest.integrationBranch) || !project.github_repo_full_name) return false
  const prNumber = latest.prNumber
  const publishedSha = latest.publishedSha
  const token = await appTokenForRepo(project.github_repo_full_name)
  const creds = installationCreds(token, project.github_repo_full_name, project.default_branch || 'main')
  const gateway = githubMergeGateway(creds)
  const meta = await readIntegrationMeta(project.id, { strict: true })
  const currentCheckpoint = async () => {
    const fresh = await getLatestKnownCheckpoint(client, project.id)
    if (!fresh || fresh.id !== latest.id || fresh.commitSha !== latest.commitSha || fresh.publishedSha !== publishedSha ||
      fresh.prNumber !== prNumber || fresh.integrationBranch !== latest.integrationBranch ||
      !['published', 'integrated'].includes(fresh.pushStatus)) throw new Error('Checkpoint avançou durante a reconciliação.')
    return fresh
  }
  const readPinnedPr = async (number: number) => {
    if (number !== prNumber) throw new Error('PR fora do checkpoint autorizado.')
    const fresh = await currentCheckpoint()
    const pr = await gateway.getPullRequest(number)
    if (pr.headSha !== publishedSha || pr.headRef !== latest.integrationBranch ||
      !isSupremoIntegrationRef(pr.headRef) || (!pr.merged && pr.state !== 'open') ||
      (fresh.pushStatus === 'integrated' && !pr.merged)) throw new Error('PR não corresponde ao checkpoint publicado.')
    return pr
  }
  const result = await reconcileProjectPr({
    gateway: {
      ...gateway,
      getPullRequest: readPinnedPr,
      merge: async (number, expectedSha) => {
        if (number !== prNumber || expectedSha !== publishedSha) throw new Error('Revisão fora do checkpoint autorizado.')
        // An independent publication or webhook can advance while policy runs.
        const pr = await readPinnedPr(number)
        if (pr.merged) return { sha: publishedSha }
        return gateway.merge(number, expectedSha)
      },
    },
    prNumber, requiredChecks: resolveRequiredChecks({}), mode: meta.mergeMode ?? 'supremo_managed',
  })
  await reconcileCheckpointsForPr(client, { projectId: project.id, prNumber, publishedSha: result.headSha }, checkpointStatusFromReconcile(result))
  const fresh = await getLatestKnownCheckpoint(client, project.id)
  if (fresh?.id === latest.id && fresh.publishedSha === result.headSha &&
    (result.merged || (fresh.pushStatus !== 'integrated' && fresh.integrationStatus !== 'merged'))) {
    // The final checkpoint read is not a lock: another reconciler can merge
    // before this UPDATE executes. Compare against the state captured before I/O.
    await writeIntegrationMeta(project.id, { integration_state: result.state }, { expectedState: meta.integrationState })
  }
  return result.merged
}

/** Background-only. The agent's preflight never waits for GitHub. */
export async function POST(request: Request): Promise<Response> {
  const parsed = schema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return Response.json({ error: 'payload inválido.' }, { status: 400 })
  try {
    const client = createServiceClient()
    const auth = await authenticateDeviceSecret(supabaseCheckpointDeviceStore(client), parsed.data.deviceSecret)
    if (!auth.ok) return Response.json({ error: 'device não autorizado.' }, { status: 401 })
    // Owner-scoped resolution BEFORE any privileged GitHub or checkpoint access.
    const project = await getProject(auth.device.ownerUserId, parsed.data.projectId)
    if (!project || project.id !== parsed.data.projectId || project.user_id !== auth.device.ownerUserId) {
      return Response.json({ error: 'projeto não autorizado.' }, { status: 403 })
    }
    const latest = await getLatestKnownCheckpoint(client, project.id)
    if (latest?.publishedSha) {
      const cached = await readCheckpointFeedback(client, project.id, latest.id)
      if (!cached || Date.now() - Date.parse(cached.observedAt) >= 45_000) {
        const observedAt = new Date().toISOString()
        const creds = await getGithubCredentials(auth.device.ownerUserId, project)
        const checks = await getChecks(creds, latest.publishedSha)
        let base = buildValidationFeedback({
          projectId: project.id, checkpointId: latest.id, commitSha: latest.commitSha,
          publishedSha: latest.publishedSha, observedAt, checksSha: checks.headSha,
          checks: checks.checks, required: resolveRequiredChecks({}),
          integrated: latest.pushStatus === 'integrated', evidence: '',
        })
        if (base.state === 'failed') {
          try {
            base = withFeedbackEvidence(base, await getFailedJobLogs(creds, latest.publishedSha, 8000))
          } catch {
            base.evidence = 'Log detalhado indisponível. Os gates identificados falharam; nova consulta automática em background.'
          }
        }
        try {
          const acceptance = await getAcceptanceEvidence(creds, project.id, latest.publishedSha)
          if (acceptance) base.acceptance = acceptance
        } catch {
          base.acceptance = undefined
        }
        await saveCheckpointFeedback(client, base)
        if (base.state === 'passed') {
          try {
            if (await retryIntegration(client, project, latest)) {
              await saveCheckpointFeedback(client, { ...base, observedAt: new Date().toISOString(),
                state: 'integrated', summary: 'Versão validada e integrada.' })
            }
          } catch {
            // Keep the CI receipt truthful and retry on a later heartbeat. No
            // upstream message (possibly credential-bearing) enters the response.
            console.info('[checkpoint.feedback] integration_retry_deferred', { projectId: project.id, checkpointId: latest.id })
          }
        }
      }
    }
    // Re-read latest after network I/O; a new publication may have arrived meanwhile.
    const fresh = await getLatestKnownCheckpoint(client, project.id)
    return Response.json(await readFeedbackEnvelope(client, project.id, fresh?.id ?? null), {
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (error) {
    if (error instanceof NotFoundError) return Response.json({ error: 'projeto não autorizado.' }, { status: 403 })
    // No upstream credential-bearing error text crosses the device boundary.
    return Response.json({ error: 'Diagnóstico indisponível; nova tentativa automática em background.' }, { status: 503 })
  }
}
