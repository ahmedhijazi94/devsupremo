import { appInstallationToken, installationCreds } from '@/lib/github/app'
import { githubMergeGateway } from '@/lib/github/gateway'
import {
  checkpointStatusFromReconcile,
  cleanupIntegrationBranchIfMerged,
  reconcileProjectPr,
  resolveRequiredChecks,
  type ReconcileLogger,
} from '@/lib/github/reconcile'
import { parseWebhookForReconcile, verifyWebhookSignature } from '@/lib/github/webhook'
import {
  getProjectByRepoFullName,
  readIntegrationMeta,
  writeIntegrationMeta,
} from '@/lib/mcp/repository'
import { mcpDataClient } from '@/lib/mcp/tokens'
import { reconcileCheckpointsForPr } from '@/lib/checkpoint/store'

/**
 * Webhook da GitHub App — o GATILHO event-driven do Merge Controller v3.
 *
 * Fluxo: valida assinatura → identifica installation/repo/PR → RELÊ o estado real
 * (PR + HEAD + checks) via installation token server-side → reconcileMerge. Nada
 * do payload autoriza merge. Responde rápido; se a CI ainda roda, encerra e o
 * próximo evento (ou o fallback) acorda de novo.
 *
 * Idempotente: reprocessar o mesmo evento converge ao mesmo estado, porque a
 * decisão vem sempre da releitura, nunca do evento.
 */
export const runtime = 'nodejs'

// Observabilidade sem segredo: nunca logamos token/payload sensível.
const logger: ReconcileLogger = {
  event(name, data) {
    console.info(`[v3.merge] ${name}`, JSON.stringify(data ?? {}))
  },
}

export async function POST(req: Request): Promise<Response> {
  const raw = await req.text()
  const secret = process.env.GITHUB_WEBHOOK_SECRET ?? ''
  const signature = req.headers.get('x-hub-signature-256')

  if (!verifyWebhookSignature(raw, signature, secret)) {
    return new Response('assinatura inválida', { status: 401 })
  }

  const event = req.headers.get('x-github-event') ?? ''
  const delivery = req.headers.get('x-github-delivery')

  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return new Response('payload inválido', { status: 400 })
  }

  const target = parseWebhookForReconcile(event, payload, delivery)
  if (!target) return Response.json({ ok: true, ignored: true })

  logger.event('webhook_received', {
    event,
    action: target.action,
    repo: target.repoFullName,
    prs: target.prNumbers,
    delivery,
  })

  try {
    const token = await appInstallationToken(target.installationId)
    const project = await getProjectByRepoFullName(target.repoFullName)
    if (!project) return Response.json({ ok: true, unknownRepo: true })

    const meta = await readIntegrationMeta(project.id)
    const mode = meta.mergeMode ?? 'supremo_managed' // fail-safe se ainda não detectado
    const gateway = githubMergeGateway(
      installationCreds(token, target.repoFullName, project.defaultBranch),
    )
    const requiredChecks = resolveRequiredChecks({}) // fail-safe estrito (conjunto completo)

    const client = mcpDataClient()
    for (const prNumber of target.prNumbers) {
      const result = await reconcileProjectPr({
        gateway,
        prNumber,
        requiredChecks,
        mode,
        log: logger,
      })
      await writeIntegrationMeta(project.id, { integration_state: result.state })
      // Reconcilia TAMBÉM o checkpoint (Histórico) — não só o projeto. Bug
      // real: só o projeto era atualizado (integration_state), o card do
      // checkpoint ficava preso em "Testando" mesmo após um merge válido.
      await reconcileCheckpointsForPr(
        client,
        { projectId: project.id, prNumber },
        checkpointStatusFromReconcile(result),
      )
      // Cleanup da integration_branch (v3-13) — SÓ depois de merge/checkpoint
      // já persistidos acima, e só quando a reconciliação confirmou merged.
      // Nunca lança (best-effort): uma falha aqui não pode desfazer nada do
      // que já foi gravado. E2E v3-12: PRs antigas já integradas deixavam
      // `supremo/cp-*` pra trás — este cleanup fecha esse rastro.
      if (result.merged) {
        const cleanup = await cleanupIntegrationBranchIfMerged(
          gateway,
          { prNumber, defaultBranch: project.defaultBranch },
          logger,
        )
        logger.event('integration_branch_cleanup_outcome', { ...cleanup })
      }
    }
  } catch (error) {
    // 200 mesmo assim: evitar retry-storm do GitHub; o fallback periódico recupera.
    logger.event('webhook_error', {
      repo: target.repoFullName,
      message: error instanceof Error ? error.message : 'erro',
    })
  }

  return Response.json({ ok: true })
}
