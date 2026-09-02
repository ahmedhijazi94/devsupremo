import { appTokenForRepo, installationCreds } from '@/lib/github/app'
import { githubMergeGateway } from '@/lib/github/gateway'
import {
  RECONCILABLE_STATES,
  reconcileProjectPr,
  resolveRequiredChecks,
  type ReconcileLogger,
} from '@/lib/github/reconcile'
import { getOpenPullRequestNumber } from '@/lib/mcp/github'
import {
  listProjectsForReconcile,
  readIntegrationMeta,
  writeIntegrationMeta,
} from '@/lib/mcp/repository'

/**
 * Fallback periódico de reconciliation (Vercel Cron) — a REDE DE SEGURANÇA do
 * merge assíncrono. O webhook é o caminho primário; este recupera webhooks
 * perdidos / erros temporários / estado dessincronizado. Roda SEM sessão de
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
      const result = await reconcileProjectPr({
        gateway: githubMergeGateway(creds),
        prNumber,
        requiredChecks: resolveRequiredChecks({}),
        mode: meta.mergeMode ?? 'supremo_managed',
        log: logger,
      })
      await writeIntegrationMeta(project.id, { integration_state: result.state })
      reconciled += 1
    } catch (error) {
      logger.event('reconciliation_error', {
        repo: project.repoFullName,
        message: error instanceof Error ? error.message : 'erro',
      })
    }
  }

  return Response.json({ ok: true, candidates: projects.length, reconciled })
}
