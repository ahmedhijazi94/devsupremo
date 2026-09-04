import { appTokenForRepo, installationCreds } from '@/lib/github/app'
import { githubMergeGateway } from '@/lib/github/gateway'
import {
  RECONCILABLE_STATES,
  checkpointStatusFromReconcile,
  cleanupIntegrationBranchIfMerged,
  reconcileProjectPr,
  resolveRequiredChecks,
  type ReconcileLogger,
} from '@/lib/github/reconcile'
import { getOpenPullRequestNumber } from '@/lib/mcp/github'
import {
  getProjectById,
  listProjectsForReconcile,
  readIntegrationMeta,
  writeIntegrationMeta,
} from '@/lib/mcp/repository'
import { mcpDataClient } from '@/lib/mcp/tokens'
import { listPendingIntegrationBranchCleanups, reconcileCheckpointsForPr } from '@/lib/checkpoint/store'

/**
 * Fallback periódico de reconciliation (Vercel Cron) — a REDE DE SEGURANÇA do
 * merge assíncrono. O caminho IMEDIATO/event-driven é o webhook (`/api/github/
 * webhook`); ESTE só recupera casos raros: webhook perdido / erro temporário /
 * estado dessincronizado.
 *
 * Roda 1x/dia (`0 3 * * *` no vercel.json) — frequência compatível com o Vercel
 * Hobby (que só permite cron >= diário). Como é apenas rede de segurança e o
 * webhook resolve em segundos, uma varredura diária basta. Roda SEM sessão de
 * agente. NÃO varre tudo: só projetos em estado relevante (ci_running/
 * merge_pending/validated). Reusa EXATAMENTE o mesmo `reconcileProjectPr`.
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

  const projects = await listProjectsForReconcile(RECONCILABLE_STATES)
  logger.event('reconciliation_sweep', { candidates: projects.length })

  let reconciled = 0
  for (const project of projects) {
    try {
      const token = await appTokenForRepo(project.repoFullName)
      const creds = installationCreds(token, project.repoFullName, project.defaultBranch)
      // Acha a PR de desenvolvimento aberta SEM criar nada.
      const prNumber = await getOpenPullRequestNumber(creds, project.activeBranch)
      if (prNumber == null) continue

      const meta = await readIntegrationMeta(project.id)
      const gateway = githubMergeGateway(creds)
      const result = await reconcileProjectPr({
        gateway,
        prNumber,
        requiredChecks: resolveRequiredChecks({}),
        mode: meta.mergeMode ?? 'supremo_managed',
        log: logger,
      })
      await writeIntegrationMeta(project.id, { integration_state: result.state })
      // Reconcilia TAMBÉM o checkpoint (Histórico) — não só o projeto. Bug
      // real: só o projeto era atualizado (integration_state), o card do
      // checkpoint ficava preso em "Testando" mesmo após um merge válido.
      await reconcileCheckpointsForPr(
        mcpDataClient(),
        { projectId: project.id, prNumber },
        checkpointStatusFromReconcile(result),
      )
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
        repo: project.repoFullName,
        message: error instanceof Error ? error.message : 'erro',
      })
    }
  }

  // Retry de cleanup pendente (v3-14) — SEGUNDA varredura, deste MESMO ciclo
  // do fallback. Necessário porque, uma vez que a PR mergeou de verdade
  // (push_status='integrated'), o projeto sai de RECONCILABLE_STATES e a PR,
  // já fechada, não aparece mais via getOpenPullRequestNumber — sem isto,
  // nada no fallback voltava a visitar uma PR já integrada pra retentar um
  // cleanup que falhou (rede/rate-limit do GitHub), mesmo com o projeto
  // parado, sem nenhuma alteração nova. `listPendingIntegrationBranchCleanups`
  // reaproveita dados que o reconcile normal já grava (nenhuma coluna nova).
  // Chama `cleanupIntegrationBranchIfMerged` DIRETO (sem reconcileProjectPr —
  // já sabemos que mergeou pelo checkpoint; a função em si já confirma de
  // novo no GitHub antes de apagar) — mesmo caminho único, nunca lança.
  const pendingCleanups = await listPendingIntegrationBranchCleanups(mcpDataClient())
  logger.event('cleanup_retry_sweep', { candidates: pendingCleanups.length })
  let cleanedUp = 0
  for (const pending of pendingCleanups) {
    try {
      const project = await getProjectById(pending.projectId)
      if (!project) continue
      const token = await appTokenForRepo(project.repoFullName)
      const creds = installationCreds(token, project.repoFullName, project.defaultBranch)
      const gateway = githubMergeGateway(creds)
      const cleanup = await cleanupIntegrationBranchIfMerged(
        gateway,
        { prNumber: pending.prNumber, defaultBranch: project.defaultBranch },
        logger,
      )
      logger.event('integration_branch_cleanup_outcome', { ...cleanup, retry: true })
      if (cleanup.deleted) cleanedUp += 1
    } catch (error) {
      // Best-effort: idêntico à varredura principal — nunca deixa um erro
      // aqui derrubar o resto do sweep nem afetar merge/checkpoint (já
      // persistidos há muito, em outro ciclo).
      logger.event('cleanup_retry_error', {
        projectId: pending.projectId,
        prNumber: pending.prNumber,
        message: error instanceof Error ? error.message : 'erro',
      })
    }
  }

  return Response.json({
    ok: true,
    candidates: projects.length,
    reconciled,
    cleanupCandidates: pendingCleanups.length,
    cleanedUp,
  })
}
