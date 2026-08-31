import { type NextRequest } from 'next/server'
import { parseAuthorizationHeader, resolveMcpToken } from '@/lib/mcp/tokens'
import * as repo from '@/lib/mcp/repository'
import { getGithubCredentials } from '@/lib/mcp/repository'
import { z } from 'zod'

/**
 * Credencial de git de curta duração para o companion clonar/puxar UM projeto.
 * O token vai só do servidor pro companion (autenticado), nunca ao navegador
 * nem ao canal Realtime. Ownership é resolvida no servidor pelo project_id —
 * o companion não escolhe o repo; o Supremo resolve a partir do dono.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest): Promise<Response> {
  const token = parseAuthorizationHeader(request.headers.get('authorization'))
  if (!token) return Response.json({ error: 'Sem token.' }, { status: 401 })

  const identity = await resolveMcpToken(token)
  if (!identity) return Response.json({ error: 'Token inválido.' }, { status: 401 })

  const body = await request.json().catch(() => null)
  const parsed = z.object({ projectId: z.string().uuid() }).safeParse(body)
  if (!parsed.success) {
    return Response.json({ error: 'projectId inválido.' }, { status: 400 })
  }

  try {
    // resolveProject filtra pelo dono — projeto de outro usuário nem aparece.
    const project = await repo.resolveProject(identity.userId, parsed.data.projectId)
    const creds = await getGithubCredentials(identity.userId, project)
    return Response.json({
      repoUrl: `https://github.com/${creds.repoFullName}.git`,
      repoFullName: creds.repoFullName,
      branch: creds.defaultBranch,
      token: creds.token,
    })
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : 'Falha ao resolver credenciais.' },
      { status: 400 },
    )
  }
}
