import { z } from 'zod'
import { createServiceClient } from '@/lib/supabase/admin'
import { authenticateDeviceSecret } from '@/lib/checkpoint/devices'
import { supabaseCheckpointDeviceStore } from '@/lib/checkpoint/store'
import { getProject, getGithubCredentials } from '@/lib/projects/repository'
import { getHeadSha, listTree, readFile } from '@/lib/github/client'
import { boundedJson } from '@/lib/database-inspection/provider'
import { authorizeProjectOperation } from '@/lib/backend-operations/server'
import { OperationError } from '@/lib/backend-operations/contract'
import { planTemplateSync } from '@/lib/templates/sync'
import { stackForVersion } from '@/lib/templates/stacks'
import { cliArtifact } from '@/lib/bootstrap/cli-artifact'
import { RUNTIME_UPDATE_PATHS, runtimeCandidateSchema } from '../../../../../packages/cli/src/runtime-update-contract'
import { mergeClaudeSettings, mergeCodexSettings } from '../../../../../packages/cli/src/host-adapters'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const schema = z.object({ projectId: z.string().uuid(), deviceSecret: z.string().min(10).max(256), operation: z.enum(['prepare', 'authorize']) }).strict()
export async function POST(request: Request): Promise<Response> {
  const headers = { 'Cache-Control': 'no-store' }
  try {
    const input = schema.parse(await boundedJson(request, 8000)), client = createServiceClient()
    const authenticate = () => authenticateDeviceSecret(supabaseCheckpointDeviceStore(client), input.deviceSecret)
    const auth = await authenticate()
    if (!auth.ok) throw new OperationError('Dispositivo não autorizado.', 401)
    const authorize = () => authorizeProjectOperation({ client, ownerId: auth.device.ownerUserId, projectId: input.projectId, deviceId: auth.device.id, environment: 'development',
      verifyIdentity: async () => { const fresh = await authenticate(); return fresh.ok ? fresh.device.ownerUserId : '' } }, 'engine.update', { resource: 'engine.tools' })
    const permission = await authorize()
    if (input.operation === 'authorize') return Response.json({ projectId: input.projectId, revision: permission.revision }, { headers })
    const project = await getProject(auth.device.ownerUserId, input.projectId), credentials = await getGithubCredentials(auth.device.ownerUserId, project)
    const baseSha = await getHeadSha(credentials, credentials.defaultBranch), pinned = { ...credentials, defaultBranch: baseSha, branch: baseSha }
    const stack = stackForVersion(project.template_version)
    const [plan, tree] = await Promise.all([planTemplateSync(pinned, { projectName: project.name, description: project.description ?? '', projectId: project.id,
      kind: z.enum(['public', 'solo', 'team']).parse(project.kind ?? 'solo'), ...(stack ? { stack } : {}) }), listTree(pinned, baseSha)])
    const allowed: ReadonlySet<string> = new Set(RUNTIME_UPDATE_PATHS), hashes = new Map(tree.map(entry => [entry.path, entry.sha]))
    const files = [...plan.creates, ...plan.updates].filter(file => allowed.has(file.path) && !file.path.startsWith('tools/supremo-cli/'))
      .map(file => ({ path: file.path, content: file.content, beforeBlob: hashes.get(file.path) ?? null }))
    for (const [file, merge] of [['.claude/settings.json', mergeClaudeSettings], ['.codex/hooks.json', mergeCodexSettings]] as const) {
      if (!hashes.has(file)) continue
      const existing = await readFile(pinned, file, baseSha)
      const content = JSON.stringify(merge(JSON.parse(existing)), null, 2) + '\n'
      if (content !== existing) files.push({ path: file, content, beforeBlob: hashes.get(file)! })
    }
    if ((await authorize()).revision !== permission.revision) throw new OperationError('A autorização mudou durante o preparo; nenhuma ferramenta foi alterada.', 409)
    return Response.json(runtimeCandidateSchema.parse({ projectId: project.id, revision: permission.revision, cliDigest: cliArtifact().digest,
      templateVersion: plan.templateVersion, baseSha, files }), { headers })
  } catch (error) {
    return Response.json({ error: error instanceof OperationError ? error.message : 'Não foi possível preparar a atualização do projeto; ferramentas existentes preservadas.' }, { status: error instanceof OperationError ? error.status : 409, headers })
  }
}
