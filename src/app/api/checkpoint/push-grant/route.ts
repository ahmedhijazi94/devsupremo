import { type NextRequest } from 'next/server'
import { z } from 'zod'
import { mcpDataClient } from '@/lib/mcp/tokens'
import { authenticateDeviceSecret } from '@/lib/checkpoint/devices'
import {
  supabaseCheckpointDeviceStore,
  upsertCheckpoint,
  setCheckpointPushStatus,
  backfillRepositoryId,
} from '@/lib/checkpoint/store'
import { authorizePushGrant, type GrantProject } from '@/lib/checkpoint/grant'
import { planIntegration, type RemoteState } from '@/lib/checkpoint/integration'
import { appTokenForRepo, installationCreds, mintRepoScopedToken } from '@/lib/github/app'
import { getHeadSha, getOpenPullRequestNumber, getPullRequest } from '@/lib/mcp/github'

/**
 * PUSH GRANT do checkpoint daemon (v3.1 item 4).
 *
 * O daemon autentica com o SECRET da máquina (nunca o valor no log/argv), pede o
 * grant para (projectId + checkpointId + diff). O backend:
 *   1. autentica o device (revogável) e confirma que o projeto é do dono;
 *   2. autoriza o grant (fail-closed) e decide permissões mínimas;
 *   3. relê o estado REAL (main HEAD + PR) e planeja a branch (reuse/rotate),
 *      preservando anti-TOCTOU (expectedBaseSha) e NUNCA a main;
 *   4. emite um installation token ESCOPADO AO REPO EXATO, curto, não persistido;
 *   5. devolve token + plano ao daemon (canal TLS autenticado). O token é
 *      descartado/revogado pelo daemon após o push.
 *
 * O token entregue tem só contents:write (+workflows:write se o diff mexe em
 * workflows) — NUNCA permissão de merge/PR/checks/admin (isso é do Control Plane).
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  deviceSecret: z.string().min(10),
  projectId: z.string().uuid(),
  checkpointId: z.string().uuid(),
  commitSha: z.string().min(7),
  parentCheckpointId: z.string().uuid().nullable().optional(),
  summary: z.string().min(1).max(500),
  riskLevel: z.enum(['low', 'medium', 'high']).default('low'),
  changedPaths: z.array(z.string()).default([]),
  migrations: z.array(z.string()).default([]),
})

export async function POST(request: NextRequest): Promise<Response> {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return Response.json({ error: 'payload inválido.' }, { status: 400 })
  }
  const body = parsed.data
  const client = mcpDataClient()

  // 1. Autentica o device (fail-closed; revogado/desconhecido não passa).
  const auth = await authenticateDeviceSecret(
    supabaseCheckpointDeviceStore(client),
    body.deviceSecret,
  )
  if (!auth.ok) {
    return Response.json({ error: 'device não autorizado.' }, { status: 401 })
  }

  // 2. Carrega o projeto (service_role) e confirma dono + repo.
  const { data: proj } = await client
    .from('projects')
    .select(
      'id, user_id, github_repo_full_name, github_owner_login, github_owner_type, default_branch, github_repo_id',
    )
    .eq('id', body.projectId)
    .maybeSingle()
  if (!proj) {
    return Response.json({ error: 'projeto não encontrado.' }, { status: 404 })
  }

  const grantProject: GrantProject = {
    id: proj.id as string,
    userId: proj.user_id as string,
    repoFullName: (proj.github_repo_full_name as string | null) ?? null,
    ownerLogin: (proj.github_owner_login as string | null) ?? null,
    ownerType: (proj.github_owner_type as 'personal' | 'organization' | null) ?? null,
    defaultBranch: (proj.default_branch as string | null) ?? 'main',
  }

  const decision = authorizePushGrant({
    device: { ownerUserId: auth.device.ownerUserId },
    project: grantProject,
    requestedProjectId: body.projectId,
    changedPaths: body.changedPaths,
  })
  if (!decision.ok) {
    return Response.json({ error: `grant recusado: ${decision.reason}` }, { status: 403 })
  }

  // 3. Relê o estado REAL do repo com credencial da App (server-side).
  const repoFullName = decision.repoFullName
  const appToken = await appTokenForRepo(repoFullName)
  const readCreds = installationCreds(appToken, repoFullName, grantProject.defaultBranch)

  const mainSha = await getHeadSha(readCreds, grantProject.defaultBranch)

  // Boundary de integração AUTORITATIVO (server-side, não confiado ao daemon): o
  // último checkpoint que foi para uma PR define a branch corrente e o SHA já
  // integrado (delta = a partir daí).
  const { data: lastCp } = await client
    .from('checkpoints')
    .select('integration_branch, commit_sha')
    .eq('project_id', body.projectId)
    .in('push_status', ['pushing', 'pushed', 'integrated'])
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

  const plan = planIntegration({
    remote: { mainSha, openPr, integrationBranch },
    local: { headSha: body.commitSha, lastIntegratedSha },
  })

  // 4. Persiste a metadata do checkpoint e emite o token escopado.
  await upsertCheckpoint(client, {
    id: body.checkpointId,
    projectId: body.projectId,
    deviceId: auth.device.id,
    commitSha: body.commitSha,
    parentCheckpointId: body.parentCheckpointId ?? null,
    summary: body.summary,
    riskLevel: body.riskLevel,
    migrations: body.migrations,
  })

  const scoped = await mintRepoScopedToken({
    repoFullName,
    permissions: decision.permissions,
    repositoryId: (proj.github_repo_id as number | null) ?? null,
  })
  if (scoped.repositoryId) {
    await backfillRepositoryId(client, body.projectId, scoped.repositoryId)
  }

  await setCheckpointPushStatus(client, body.checkpointId, 'pushing', {
    integrationBranch: plan.branch,
  })
  await supabaseCheckpointDeviceStore(client).touch(
    auth.device.id,
    new Date().toISOString(),
  )

  // 5. Devolve o token + plano (TLS autenticado). O daemon descarta o token.
  return Response.json({
    token: scoped.token,
    tokenExpiresAt: scoped.expiresAt,
    repoFullName,
    plan,
  })
}
