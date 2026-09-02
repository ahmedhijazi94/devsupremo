import { type NextRequest } from 'next/server'
import { z } from 'zod'
import { mcpDataClient } from '@/lib/mcp/tokens'
import { authenticateDeviceSecret } from '@/lib/checkpoint/devices'
import {
  supabaseCheckpointDeviceStore,
  upsertCheckpoint,
  setCheckpointPushStatus,
  getCheckpointState,
  backfillRepositoryId,
} from '@/lib/checkpoint/store'
import { authorizePushGrant, type GrantProject } from '@/lib/checkpoint/grant'
import { planIntegration, type RemoteState } from '@/lib/checkpoint/integration'
import { validateChangeset, type Changeset } from '@/lib/checkpoint/changeset'
import { applyChangeset } from '@/lib/checkpoint/publish'
import {
  appTokenForRepo,
  installationCreds,
  mintRepoScopedToken,
  revokeInstallationToken,
} from '@/lib/github/app'
import {
  getHeadSha,
  getOpenPullRequestNumber,
  getPullRequest,
  openOrUpdatePullRequest,
} from '@/lib/mcp/github'

/**
 * PUBLISH do checkpoint — TUDO server-side. O daemon manda o CHANGESET (nunca
 * recebe token); o backend valida, deriva a branch de integração, publica via Git
 * Data API com um token da App emitido/usado/revogado AQUI, e garante a PR. A main
 * é IMPOSSÍVEL por este endpoint: a branch é derivada server-side, e a default/
 * protegida é rejeitada (assertPublishableTarget dentro de applyChangeset).
 *
 * Nenhum GitHub token é retornado, logado ou entregue ao cliente. O agente já está
 * livre desde o checkpoint local; isto roda no daemon, em background.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const fileOpSchema = z.object({
  path: z.string().min(1),
  op: z.enum(['add', 'modify', 'delete']),
  contentBase64: z.string().optional(),
  sha256: z.string().optional(),
  mode: z.enum(['100644', '100755']).optional(),
})

const changesetSchema = z.object({
  checkpointId: z.string().uuid(),
  commitSha: z.string().min(7),
  parentCheckpointId: z.string().uuid().nullable(),
  message: z.string().min(1).max(2000),
  authorName: z.string().min(1).max(200),
  authorEmail: z.string().min(1).max(320),
  files: z.array(fileOpSchema).max(5000),
})

const bodySchema = z.object({
  deviceSecret: z.string().min(10),
  projectId: z.string().uuid(),
  changeset: changesetSchema,
  changesetSha256: z.string().length(64),
  riskLevel: z.enum(['low', 'medium', 'high']).default('low'),
  summary: z.string().min(1).max(500),
  migrations: z.array(z.string()).default([]),
  // Histórico (v3.1 finalização) — opcionais; ausência não quebra nada.
  conversationId: z.string().max(200).nullable().optional(),
  messageId: z.string().max(200).nullable().optional(),
  originAgent: z.string().max(50).nullable().optional(),
  /** Presente quando este checkpoint é o "E" resultante de um restore. */
  restoredFromCheckpointId: z.string().uuid().nullable().optional(),
})

export async function POST(request: NextRequest): Promise<Response> {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return Response.json({ error: 'payload inválido.' }, { status: 400 })
  }
  const body = parsed.data
  const changeset = body.changeset as Changeset
  const client = mcpDataClient()

  // 1. Autentica o device (fail-closed).
  const auth = await authenticateDeviceSecret(
    supabaseCheckpointDeviceStore(client),
    body.deviceSecret,
  )
  if (!auth.ok) return Response.json({ error: 'device não autorizado.' }, { status: 401 })

  // 2. Carrega o projeto e DERIVA repo/owner do project_id (nunca do cliente).
  const { data: proj } = await client
    .from('projects')
    .select(
      'id, user_id, github_repo_full_name, github_owner_login, github_owner_type, default_branch, github_repo_id',
    )
    .eq('id', body.projectId)
    .maybeSingle()
  if (!proj) return Response.json({ error: 'projeto não encontrado.' }, { status: 404 })

  const defaultBranch = (proj.default_branch as string | null) ?? 'main'
  const grantProject: GrantProject = {
    id: proj.id as string,
    userId: proj.user_id as string,
    repoFullName: (proj.github_repo_full_name as string | null) ?? null,
    ownerLogin: (proj.github_owner_login as string | null) ?? null,
    ownerType: (proj.github_owner_type as 'personal' | 'organization' | null) ?? null,
    defaultBranch,
  }

  // 3. Autoriza (fail-closed): device do dono, projeto pedido == carregado, repo ok.
  const decision = authorizePushGrant({
    device: { ownerUserId: auth.device.ownerUserId },
    project: grantProject,
    requestedProjectId: body.projectId,
    changedPaths: changeset.files.map((f) => f.path),
  })
  if (!decision.ok) {
    return Response.json({ error: `publish recusado: ${decision.reason}` }, { status: 403 })
  }
  const repoFullName = decision.repoFullName

  // 4. Integridade + tamanho do changeset (adulterado/grande demais → rejeita).
  const valid = validateChangeset({
    changeset,
    declaredSha256: body.changesetSha256,
  })
  if (!valid.ok) {
    const status = valid.reason === 'too_large' ? 413 : 422
    return Response.json({ error: `changeset inválido: ${valid.reason}` }, { status })
  }

  // 5. Idempotência: se este checkpoint já foi publicado, devolve a PR existente.
  const existing = await getCheckpointState(client, changeset.checkpointId)
  if (
    existing &&
    (existing.pushStatus === 'published' || existing.pushStatus === 'integrated') &&
    existing.prNumber != null
  ) {
    return Response.json({ prNumber: existing.prNumber, published: true, idempotent: true })
  }

  // 6. Estado REAL do repo (Control Plane, installation token server-side).
  const controlToken = await appTokenForRepo(repoFullName)
  const readCreds = installationCreds(controlToken, repoFullName, defaultBranch)

  let writeToken: string | null = null
  try {
    const mainSha = await getHeadSha(readCreds, defaultBranch)

    // Branch de integração corrente + SHA já integrado (authoritative, server-side).
    const { data: lastCp } = await client
      .from('checkpoints')
      .select('integration_branch, commit_sha, published_sha')
      .eq('project_id', body.projectId)
      .in('push_status', ['publishing', 'published', 'integrated'])
      .not('integration_branch', 'is', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    const integrationBranch = (lastCp?.integration_branch as string | null) ?? null
    const lastIntegratedSha = (lastCp?.commit_sha as string | null) ?? null

    let openPr: RemoteState['openPr'] = null
    if (integrationBranch) {
      const prNumber = await getOpenPullRequestNumber(readCreds, integrationBranch)
      if (prNumber) {
        const pr = await getPullRequest(readCreds, prNumber)
        openPr = {
          number: pr.number,
          headRef: pr.headRef,
          headSha: pr.headSha,
          merged: pr.merged,
          state: pr.state,
        }
      }
    }

    // 7. DERIVA a branch server-side (nunca a fornecida pelo cliente). reuse
    //    aplica sobre o tip da branch; rotate cria nova branch sobre a main.
    const plan = planIntegration({
      remote: { mainSha, openPr, integrationBranch },
      local: { headSha: changeset.commitSha, lastIntegratedSha },
    })
    const baseSha =
      plan.action === 'reuse' && openPr ? openPr.headSha : plan.expectedBaseSha

    // 8. Marca em publicação e emite o token de WRITE mínimo (server-side).
    await upsertCheckpoint(client, {
      id: changeset.checkpointId,
      projectId: body.projectId,
      deviceId: auth.device.id,
      commitSha: changeset.commitSha,
      parentCheckpointId: changeset.parentCheckpointId,
      summary: body.summary,
      riskLevel: body.riskLevel,
      migrations: body.migrations,
      conversationId: body.conversationId,
      messageId: body.messageId,
      originAgent: body.originAgent,
      restoredFromCheckpointId: body.restoredFromCheckpointId,
    })

    const scoped = await mintRepoScopedToken({
      repoFullName,
      permissions: decision.permissions, // contents:write (+workflows:write se aplicável)
      repositoryId: (proj.github_repo_id as number | null) ?? null,
    })
    writeToken = scoped.token
    if (scoped.repositoryId) await backfillRepositoryId(client, body.projectId, scoped.repositoryId)

    // 9. Publica o changeset via Git Data API (token de write, server-side).
    const writeCreds = installationCreds(scoped.token, repoFullName, defaultBranch)
    const applied = await applyChangeset(writeCreds, {
      branch: plan.branch,
      baseSha,
      defaultBranch,
      files: changeset.files,
      message: changeset.message,
      authorName: changeset.authorName,
      authorEmail: changeset.authorEmail,
    })

    // 10. Garante a PR (Control Plane). base = main, head = branch de integração.
    const pr = await openOrUpdatePullRequest(
      readCreds,
      plan.branch,
      `Supremo checkpoint: ${body.summary}`,
      'PR gerada pelo Control Plane do Supremo (v3.1 endurecido). CI e merge são assíncronos.',
      defaultBranch,
    )

    await setCheckpointPushStatus(client, changeset.checkpointId, 'published', {
      prNumber: pr.number,
      integrationBranch: plan.branch,
      integrationStatus: 'ci_running',
      publishedSha: applied.commitSha,
    })

    // 11. Resposta SEM token nenhum.
    return Response.json({ prNumber: pr.number, url: pr.url, published: true })
  } catch (err) {
    // Non-ff / corrida / falha de rede: retriável (o daemon re-tenta; server
    // re-planeja). Marca a falha sem vazar detalhe sensível.
    await setCheckpointPushStatus(client, changeset.checkpointId, 'failed').catch(() => {})
    const msg = err instanceof Error ? err.message : 'falha ao publicar'
    return Response.json({ error: msg }, { status: 409 })
  } finally {
    // 12. Revoga os tokens IMEDIATAMENTE (janela mínima). Nunca retornados/logados.
    if (writeToken) await revokeInstallationToken(writeToken).catch(() => {})
    await revokeInstallationToken(controlToken).catch(() => {})
  }
}
