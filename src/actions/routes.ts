'use server'

import { z } from 'zod'
import { requireProjectOwner, toActionError } from '@/lib/auth'
import { decryptToken } from '@/lib/crypto'
import { listTree } from '@/lib/mcp/github'
import type { GithubCredentials } from '@/lib/mcp/repository'

/**
 * As páginas do app, lidas do repositório — para o seletor de rotas do preview.
 *
 * Num app Next (App Router), cada `app/**\/page.tsx` é uma página. Derivamos a
 * URL a partir do caminho, tirando os grupos de rota `(...)`. Rotas dinâmicas
 * (`[slug]`) aparecem marcadas — sem um valor, não dá para abrir direto. As
 * rotas de API (`route.ts`) vêm à parte: não abrem no preview, mas é útil ver
 * que existem.
 */

const PROJECT_COLUMNS =
  'id, user_id, github_account_id, github_repo_full_name, default_branch'

async function resolveGithub(
  projectId: string,
): Promise<
  { ok: true; creds: GithubCredentials } | { ok: false; error: string }
> {
  const { user, supabase, project } = await requireProjectOwner(
    projectId,
    PROJECT_COLUMNS,
  )

  const repoFullName = project.github_repo_full_name as string | null
  const accountId = project.github_account_id as string | null
  if (!repoFullName || !accountId) {
    return { ok: false, error: 'Projeto ainda não provisionado no GitHub.' }
  }

  const { data: account } = await supabase
    .from('github_accounts')
    .select('access_token_encrypted')
    .eq('id', accountId)
    .eq('user_id', user.id)
    .maybeSingle()
  if (!account) return { ok: false, error: 'Conta GitHub não encontrada.' }

  const [owner, repo] = repoFullName.split('/')
  if (!owner || !repo) return { ok: false, error: 'Repositório inválido.' }

  const defaultBranch = (project.default_branch as string | null) ?? 'main'
  return {
    ok: true,
    creds: {
      token: decryptToken(account.access_token_encrypted as string),
      repoFullName,
      owner,
      repo,
      branch: defaultBranch,
      defaultBranch,
    },
  }
}

/** Converte `app/(auth)/login/page.tsx` em `/login`. */
function pageToRoute(path: string): { path: string; dynamic: boolean } | null {
  const match = /^app\/(.*\/)?page\.tsx$/.exec(path)
  if (!match) return null

  const segments = (match[1] ?? '')
    .split('/')
    .filter(Boolean)
    // Grupos de rota não entram na URL.
    .filter((seg) => !(seg.startsWith('(') && seg.endsWith(')')))

  const route = '/' + segments.join('/')
  const dynamic = segments.some((seg) => seg.includes('[') && seg.includes(']'))
  return { path: route === '/' ? '/' : route.replace(/\/$/, ''), dynamic }
}

export interface AppRoutes {
  pages: Array<{ path: string; dynamic: boolean }>
  apis: string[]
}

export async function getAppRoutes(
  projectId: string,
): Promise<{ data?: AppRoutes; error?: string }> {
  if (!z.string().uuid().safeParse(projectId).success) {
    return { error: 'ID inválido.' }
  }

  try {
    const resolved = await resolveGithub(projectId)
    if (!resolved.ok) return { error: resolved.error }

    const tree = await listTree(resolved.creds, resolved.creds.defaultBranch)

    const pages = tree
      .map((entry) => pageToRoute(entry.path))
      .filter((route): route is { path: string; dynamic: boolean } =>
        Boolean(route),
      )
      // Ordena com a home primeiro, o resto alfabético.
      .sort((a, b) =>
        a.path === '/' ? -1 : b.path === '/' ? 1 : a.path.localeCompare(b.path),
      )

    const apis = tree
      .map((entry) => /^app\/(.*\/)?route\.ts$/.exec(entry.path))
      .filter((m): m is RegExpExecArray => Boolean(m))
      .map((m) => {
        const segments = (m[1] ?? '')
          .split('/')
          .filter(Boolean)
          .filter((seg) => !(seg.startsWith('(') && seg.endsWith(')')))
        return '/' + segments.join('/')
      })
      .sort()

    // Dedup (grupos de rota podem colidir).
    const seen = new Set<string>()
    const uniquePages = pages.filter((p) =>
      seen.has(p.path) ? false : (seen.add(p.path), true),
    )

    return { data: { pages: uniquePages, apis } }
  } catch (error) {
    return { error: toActionError(error) }
  }
}
