import { z } from 'zod'
import { createServiceClient } from '@/lib/supabase/admin'
import { authenticateDeviceSecret } from '@/lib/checkpoint/devices'
import { getLatestKnownCheckpoint, supabaseCheckpointDeviceStore } from '@/lib/checkpoint/store'
import { readCheckpointFeedback, readFeedbackEnvelope, saveCheckpointFeedback } from '@/lib/checkpoint/feedback-store'
import { buildValidationFeedback, withFeedbackEvidence } from '@/lib/checkpoint/feedback'
import { getProject, getGithubCredentials, NotFoundError } from '@/lib/projects/repository'
import { getChecks, getFailedJobLogs } from '@/lib/github/client'
import { resolveRequiredChecks } from '@/lib/github/reconcile'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60
const schema = z.object({ deviceSecret: z.string().min(10).max(256), projectId: z.string().uuid() })

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
    if (!project) return Response.json({ error: 'projeto não autorizado.' }, { status: 403 })
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
        await saveCheckpointFeedback(client, base)
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
