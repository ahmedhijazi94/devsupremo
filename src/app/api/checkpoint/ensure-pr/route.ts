import { type NextRequest } from 'next/server'
import { z } from 'zod'
import { mcpDataClient } from '@/lib/mcp/tokens'
import { authenticateDeviceSecret } from '@/lib/checkpoint/devices'
import {
  supabaseCheckpointDeviceStore,
  setCheckpointPushStatus,
} from '@/lib/checkpoint/store'
import { assertNotMain } from '@/lib/checkpoint/integration'
import { appTokenForRepo, installationCreds } from '@/lib/github/app'
import { openOrUpdatePullRequest } from '@/lib/mcp/github'

/**
 * ENSURE-PR do checkpoint daemon: depois que o daemon EMPURROU a branch, o
 * backend GARANTE a PR server-side (com credencial da App), sem o daemon esperar
 * CI. Idempotente: se a PR já existe, devolve a existente. A base é sempre a main
 * e o head é a branch de integração — NUNCA a main como head/target de push.
 *
 * O daemon já está livre; o Control Plane (webhook + fallback) cuida de CI/merge.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  deviceSecret: z.string().min(10),
  projectId: z.string().uuid(),
  checkpointId: z.string().uuid(),
  branch: z.string().min(1),
  summary: z.string().min(1).max(500).default('checkpoint'),
})

export async function POST(request: NextRequest): Promise<Response> {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return Response.json({ error: 'payload inválido.' }, { status: 400 })
  }
  const body = parsed.data

  // Nunca abrir PR usando a main como head (defesa extra além do daemon).
  try {
    assertNotMain(body.branch)
  } catch {
    return Response.json({ error: 'branch inválida.' }, { status: 400 })
  }

  const client = mcpDataClient()
  const auth = await authenticateDeviceSecret(
    supabaseCheckpointDeviceStore(client),
    body.deviceSecret,
  )
  if (!auth.ok) {
    return Response.json({ error: 'device não autorizado.' }, { status: 401 })
  }

  const { data: proj } = await client
    .from('projects')
    .select('id, user_id, github_repo_full_name, default_branch')
    .eq('id', body.projectId)
    .maybeSingle()
  if (!proj || (proj.user_id as string) !== auth.device.ownerUserId) {
    return Response.json({ error: 'projeto não encontrado.' }, { status: 404 })
  }
  const repoFullName = proj.github_repo_full_name as string | null
  if (!repoFullName) {
    return Response.json({ error: 'repo não provisionado.' }, { status: 400 })
  }

  const appToken = await appTokenForRepo(repoFullName)
  const creds = installationCreds(
    appToken,
    repoFullName,
    (proj.default_branch as string | null) ?? 'main',
  )

  const pr = await openOrUpdatePullRequest(
    creds,
    body.branch,
    `Supremo checkpoint: ${body.summary}`,
    'PR gerada automaticamente pelo checkpoint daemon (v3.1). CI e merge são do Control Plane.',
    creds.defaultBranch,
  )

  await setCheckpointPushStatus(client, body.checkpointId, 'pushed', {
    prNumber: pr.number,
    integrationBranch: body.branch,
    integrationStatus: 'ci_running',
  })

  return Response.json({ prNumber: pr.number, url: pr.url })
}
