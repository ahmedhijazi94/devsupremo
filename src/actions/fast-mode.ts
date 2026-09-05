'use server'

import { z } from 'zod'
import { requireProjectOwner, toActionError } from '@/lib/auth'
import { freshGithubToken } from '@/lib/github-token'
import { enableBranchProtection } from '@/lib/github/client'
import type { GithubCredentials } from '@/lib/projects/repository'
import { requiredGates } from '@/lib/templates/project-files'

/**
 * Modo rápido, por projeto. Rápido como Lovable, seguro sempre.
 *
 * A segurança por ESTRUTURA (RLS obrigatório, auth.uid(), guard de SQL, sem
 * segredo no código) é validada no write, instantânea — não depende deste
 * modo. O modo rápido só muda o conjunto de gates OBRIGATÓRIOS para o merge:
 * os baratos (tipos, build, segredos, vulnerabilidades) ficam sempre; os lentos
 * (testes, E2E) deixam de travar. O teste de RLS trava ou avisa conforme a
 * escolha do projeto. Reaplica a proteção de branch, senão o GitHub bloquearia
 * o merge mesmo com o modo ligado.
 */

const PROJECT_COLUMNS =
  'id, user_id, github_account_id, github_repo_full_name, default_branch, ' +
  'fast_mode, fast_mode_rls'

export interface FastModeState {
  fastMode: boolean
  rlsMode: 'block' | 'warn'
}

async function resolveGithub(
  projectId: string,
): Promise<
  | { ok: true; creds: GithubCredentials; defaultBranch: string }
  | { ok: false; error: string }
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
    .select('access_token_encrypted, refresh_token_encrypted, token_expires_at')
    .eq('id', accountId)
    .eq('user_id', user.id)
    .maybeSingle()
  if (!account) return { ok: false, error: 'Conta GitHub não encontrada.' }

  const [owner, repo] = repoFullName.split('/')
  if (!owner || !repo) return { ok: false, error: 'Repositório inválido.' }

  const token = await freshGithubToken(account, (update) =>
    supabase
      .from('github_accounts')
      .update(update)
      .eq('id', accountId)
      .eq('user_id', user.id),
  )
  const defaultBranch = (project.default_branch as string | null) ?? 'main'

  return {
    ok: true,
    defaultBranch,
    creds: {
      token,
      repoFullName,
      owner,
      repo,
      branch: defaultBranch,
      defaultBranch,
    },
  }
}

export async function getFastMode(
  projectId: string,
): Promise<{ state?: FastModeState; error?: string }> {
  if (!z.string().uuid().safeParse(projectId).success) {
    return { error: 'ID inválido.' }
  }
  try {
    const { project } = await requireProjectOwner(
      projectId,
      'id, user_id, fast_mode, fast_mode_rls',
    )
    return {
      state: {
        fastMode: Boolean(project.fast_mode),
        rlsMode:
          (project.fast_mode_rls as 'block' | 'warn' | null) ?? 'block',
      },
    }
  } catch (error) {
    return { error: toActionError(error) }
  }
}

export async function setFastMode(input: {
  projectId: string
  fastMode: boolean
  rlsMode: 'block' | 'warn'
}): Promise<{ ok?: true; warning?: string; error?: string }> {
  const parsed = z
    .object({
      projectId: z.string().uuid(),
      fastMode: z.boolean(),
      rlsMode: z.enum(['block', 'warn']),
    })
    .safeParse(input)
  if (!parsed.success) return { error: 'Dados inválidos.' }

  const { projectId, fastMode, rlsMode } = parsed.data

  try {
    const { user, supabase } = await requireProjectOwner(
      projectId,
      'id, user_id',
    )

    await supabase
      .from('projects')
      .update({ fast_mode: fastMode, fast_mode_rls: rlsMode })
      .eq('id', projectId)
      .eq('user_id', user.id)

    // Reaplica a proteção de branch com o conjunto de gates do modo. Sem isto o
    // GitHub continuaria exigindo TODOS os checks e o merge rápido não passaria.
    const resolved = await resolveGithub(projectId)
    if (!resolved.ok) {
      return {
        warning:
          'Modo salvo, mas a proteção de branch não pôde ser reaplicada: ' +
          resolved.error,
      }
    }

    try {
      await enableBranchProtection(
        resolved.creds,
        resolved.defaultBranch,
        requiredGates(fastMode, rlsMode),
      )
    } catch (error) {
      // Repositório em plano sem proteção de branch: o modo vale pelo Supremo
      // (merge_when_green e o botão respeitam), só não pelo GitHub.
      return {
        warning:
          'Modo salvo. A proteção de branch não pôde ser ajustada no GitHub ' +
          `(${toActionError(error)}), mas o merge pelo Supremo respeita o modo.`,
      }
    }

    return { ok: true }
  } catch (error) {
    return { error: toActionError(error) }
  }
}
