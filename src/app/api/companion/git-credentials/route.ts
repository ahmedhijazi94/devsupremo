import { type NextRequest } from 'next/server'
import { parseAuthorizationHeader, resolveMcpToken } from '@/lib/mcp/tokens'
import * as repo from '@/lib/mcp/repository'
import { getGithubCredentials, getSupabaseCredentials } from '@/lib/mcp/repository'
import { getSupabaseAnonKey } from '@/lib/preview'
import { z } from 'zod'

/**
 * Credencial de git de curta duração + env PÚBLICAS do projeto, para o companion
 * clonar e subir o dev server. O token de git vai só do servidor pro companion
 * (autenticado), nunca ao navegador nem ao canal. As env são só as NEXT_PUBLIC_
 * (URL e anon key do Supabase) — públicas por design; sem elas o app não inicia
 * (tela branca). Ownership resolvida no servidor pelo project_id.
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

    // Env PÚBLICAS do projeto (sem elas o app fica em branco). Best-effort: se
    // não houver Supabase vinculado, o dev sobe sem elas (o app avisa).
    const env: Record<string, string> = {}
    try {
      const supa = await getSupabaseCredentials(identity.userId, project)
      env.NEXT_PUBLIC_SUPABASE_URL = `https://${supa.projectRef}.supabase.co`
      const anon = await getSupabaseAnonKey(supa.token, supa.projectRef)
      if (anon) env.NEXT_PUBLIC_SUPABASE_ANON_KEY = anon
    } catch {
      // projeto sem Supabase: segue sem as env
    }

    return Response.json({
      repoUrl: `https://github.com/${creds.repoFullName}.git`,
      repoFullName: creds.repoFullName,
      branch: creds.defaultBranch,
      token: creds.token,
      env,
    })
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : 'Falha ao resolver credenciais.' },
      { status: 400 },
    )
  }
}
