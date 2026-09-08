import { appTokenForRepo, installationCreds } from '@/lib/github/app'
import { githubMergeGateway } from '@/lib/github/gateway'
import {
  checkpointStatusFromReconcile,
  cleanupIntegrationBranchIfMerged,
  reconcileProjectPr,
  resolveRequiredChecks,
  type ReconcileLogger,
} from '@/lib/github/reconcile'
import {
  getProjectById,
  readIntegrationMeta,
  writeIntegrationMeta,
} from '@/lib/projects/repository'
import { createServiceClient } from '@/lib/supabase/admin'
import { listPendingCheckpointReconciliations, getLatestKnownCheckpoint, reconcileCheckpointsForPr } from '@/lib/checkpoint/store'
import { capturePrFeedback } from '@/lib/checkpoint/feedback-capture'

/**
 * Fallback periódico de reconciliation (Vercel Cron) — a REDE DE SEGURANÇA do
 * merge assíncrono. O caminho IMEDIATO/event-driven é o webhook (`/api/github/
 * webhook`); ESTE só recupera casos raros: webhook perdido / erro temporário /
 * estado dessincronizado.
 *
 * Roda 1x/dia (`0 3 * * *` no vercel.json) — frequência compatível com o Vercel
 * Hobby (que só permite cron >= diário). Como é apenas rede de segurança e o
 * webhook resolve em segundos, uma varredura diária basta. Roda SEM sessão de
 * agente. Descobre PRs pelos checkpoints publicados, inclusive fechadas e
 * projetos cujo primeiro webhook nunca chegou. Reusa `reconcileProjectPr`.
 */
export const runtime = 'nodejs'
export const maxDuration = 60

const logger: ReconcileLogger = {
  event(name, data) {
    console.info(`[v3.merge] ${name}`, JSON.stringify(data ?? {}))
  },
}

/** Cron da Vercel manda `Authorization: Bearer $CRON_SECRET`. */
function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  return req.headers.get('authorization') === `Bearer ${secret}`
}

export async function GET(req: Request): Promise<Response> {
  if (!authorized(req)) return new Response('não autorizado', { status: 401 })

  const client = createServiceClient()
  const projects = await listPendingCheckpointReconciliations(client)
  logger.event('reconciliation_sweep', { candidates: projects.length })

  let reconciled = 0
  for (const candidate of projects) {
    try {
      const project = await getProjectById(candidate.projectId)
      if (!project) continue
      const token = await appTokenForRepo(project.repoFullName)
      const creds = installationCreds(token, project.repoFullName, project.defaultBranch)
      const prNumber = candidate.prNumber

      const meta = await readIntegrationMeta(project.id)
      const gateway = githubMergeGateway(creds)
      const result = await reconcileProjectPr({
        gateway,
        prNumber,
        requiredChecks: resolveRequiredChecks({}),
        mode: meta.mergeMode ?? 'supremo_managed',
        log: logger,
      })
      const latest = await getLatestKnownCheckpoint(client, project.id)
      if (latest?.prNumber === prNumber) await writeIntegrationMeta(project.id, { integration_state: result.state })
      // Reconcilia TAMBÉM o checkpoint (Histórico) — não só o projeto. Bug
      // real: só o projeto era atualizado (integration_state), o card do
      // checkpoint ficava preso em "Testando" mesmo após um merge válido.
      await reconcileCheckpointsForPr(
        createServiceClient(),
        { projectId: project.id, prNumber, publishedSha: result.headSha },
        checkpointStatusFromReconcile(result),
      )
      try {
        await capturePrFeedback(createServiceClient(), project.id, creds, prNumber)
      } catch {
        logger.event('feedback_capture_deferred', { projectId: project.id, prNumber })
      }
      // Cleanup da integration_branch (v3-13) — MESMO caminho do webhook, pra
      // isto ser repetível aqui também (rede de segurança) se o webhook tiver
      // perdido/falhado o cleanup dele. Nunca lança: best-effort, não afeta
      // merge/checkpoint já persistidos acima.
      if (result.merged) {
        const cleanup = await cleanupIntegrationBranchIfMerged(
          gateway,
          { prNumber, defaultBranch: project.defaultBranch },
          logger,
        )
        logger.event('integration_branch_cleanup_outcome', { ...cleanup })
      }
      reconciled += 1
    } catch (error) {
      logger.event('reconciliation_error', {
        projectId: candidate.projectId,
        message: error instanceof Error ? error.message : 'erro',
      })
    }
  }

  return Response.json({ ok: true, candidates: projects.length, reconciled })
}
