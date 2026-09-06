import { authenticateDeviceSecret } from '@/lib/checkpoint/devices'
import { readFeedbackEnvelope } from '@/lib/checkpoint/feedback-store'
import { getLatestKnownCheckpoint, supabaseCheckpointDeviceStore } from '@/lib/checkpoint/store'
import { backendTurnContextSchema, turnContextRequestSchema } from '@/lib/checkpoint/turn-context'
import { describeEnvironment } from '@/lib/database-environment/policy'
import { readEnvironment } from '@/lib/database-environment/store'
import { getProject, NotFoundError } from '@/lib/projects/repository'
import { createServiceClient } from '@/lib/supabase/admin'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 10

const headers = { 'Cache-Control': 'no-store' }

/**
 * One bounded reconciliation at turn start. Never waits for GitHub or CI:
 * webhook/cron/daemon persist evidence even when this workspace is offline.
 * Device authentication is independent of cookies; the /api proxy rate limit
 * also covers this route. This read grants no database or repository mutation.
 */
export async function POST(request: Request): Promise<Response> {
  const parsed = turnContextRequestSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return Response.json({ error: 'payload inválido.' }, { status: 400, headers })
  try {
    const client = createServiceClient()
    const auth = await authenticateDeviceSecret(supabaseCheckpointDeviceStore(client), parsed.data.deviceSecret)
    if (!auth.ok) return Response.json({ error: 'device não autorizado.' }, { status: 401, headers })

    // IDs supplied by a device do not authorize access: owner resolution first.
    const project = await getProject(auth.device.ownerUserId, parsed.data.projectId)
    if (project.id !== parsed.data.projectId || project.user_id !== auth.device.ownerUserId) {
      return Response.json({ error: 'projeto não autorizado.' }, { status: 403, headers })
    }
    if (!project.github_repo_full_name) {
      return Response.json({ error: 'projeto sem repositório provisionado.' }, { status: 409, headers })
    }
    const database = describeEnvironment(await readEnvironment(client, project.id), project.supabase_project_ref)
    let latest = await getLatestKnownCheckpoint(client, project.id)
    // A publication may arrive between reads. Never label feedback from A as B.
    // Retry only twice; continuous publication asks the host to retry safely.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const feedback = await readFeedbackEnvelope(client, project.id, latest?.id ?? null)
      const fresh = await getLatestKnownCheckpoint(client, project.id)
      if (fresh?.id !== latest?.id || fresh?.publishedSha !== latest?.publishedSha || fresh?.commitSha !== latest?.commitSha) {
        latest = fresh
        continue
      }
      const result = backendTurnContextSchema.parse({
        version: 1,
        projectId: project.id,
        project: { id: project.id, name: project.name },
        repository: {
          fullName: project.github_repo_full_name,
          url: `https://github.com/${project.github_repo_full_name}.git`,
          branch: project.active_branch || project.default_branch || 'main',
          defaultBranch: project.default_branch || 'main',
        },
        environment: database.environment,
        databaseEnvironment: database.environment,
        databaseAuthority: {
          projectRef: database.projectRef, source: database.source, automaticMigrations: database.automaticMigrations,
        },
        latestCheckpoint: fresh ? {
          id: fresh.id, localSha: fresh.commitSha, publishedSha: fresh.publishedSha,
          pushStatus: fresh.pushStatus, integrationStatus: fresh.integrationStatus,
          integrationBranch: fresh.integrationBranch, createdAt: fresh.createdAt,
        } : null,
        feedback,
        observedAt: new Date().toISOString(),
      })
      return Response.json(result, { headers })
    }
    return Response.json({ error: 'Publicação concorrente; reconcilie novamente antes de modificar arquivos.' }, { status: 409, headers })
  } catch (error) {
    if (error instanceof NotFoundError) return Response.json({ error: 'projeto não autorizado.' }, { status: 403, headers })
    // An unavailable query must not manufacture a clean/unknown recovery state.
    return Response.json({ error: 'Contexto indisponível; mantenha as pendências e tente reconciliar novamente.' }, { status: 503, headers })
  }
}
