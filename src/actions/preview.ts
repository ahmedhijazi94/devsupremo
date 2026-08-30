'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireProjectOwner, toActionError } from '@/lib/auth'
import { decryptToken } from '@/lib/crypto'
import {
  previewProjectName,
  publishSharedPreview,
  readSharedPreview,
  sharedPreviewConfig,
} from '@/lib/preview'
import { listTree, readFile } from '@/lib/mcp/github'
import type { DeployFile } from '@/lib/vercel'

/**
 * Publicação do preview compartilhado.
 *
 * Os arquivos saem do repositório do usuário e vão para a conta Vercel do
 * Supremo. Quem usa não conecta Vercel nem autoriza o app dela no GitHub —
 * é o que reduz o caminho a GitHub e Supabase.
 */

/** Repositórios muito grandes travariam o envio; o template cabe folgado. */
const MAX_FILES = 400

export interface PublishPreviewResult {
  error?: string
  url?: string
  state?: string
}

export async function publishPreview(
  projectId: string
): Promise<PublishPreviewResult> {
  const parsed = z.string().uuid().safeParse(projectId)
  if (!parsed.success) return { error: 'ID inválido.' }

  const config = sharedPreviewConfig()
  if (!config) {
    return {
      error:
        'O preview compartilhado não está configurado neste ambiente. ' +
        'Conecte uma conta Vercel em Contas para publicar na sua própria.',
    }
  }

  try {
    const { user, supabase, project } = await requireProjectOwner(
      parsed.data,
      'id, user_id, name, github_account_id, github_repo_full_name, ' +
        'active_branch, default_branch, supabase_project_ref, ' +
        'supabase_account_id, preview_project_name'
    )

    const repoFullName = project.github_repo_full_name as string | null
    const githubAccountId = project.github_account_id as string | null

    if (!repoFullName || !githubAccountId) {
      return { error: 'Projeto ainda não provisionado no GitHub.' }
    }

    const { data: githubAccount } = await supabase
      .from('github_accounts')
      .select('access_token_encrypted')
      .eq('id', githubAccountId)
      .eq('user_id', user.id)
      .maybeSingle()

    if (!githubAccount) return { error: 'Conta GitHub não encontrada.' }

    const [owner, repo] = repoFullName.split('/')
    if (!owner || !repo) return { error: 'Repositório inválido.' }

    const branch =
      (project.active_branch as string | null) ??
      (project.default_branch as string | null) ??
      'main'

    const credentials = {
      token: decryptToken(githubAccount.access_token_encrypted as string),
      repoFullName,
      owner,
      repo,
      branch,
      defaultBranch: (project.default_branch as string | null) ?? 'main',
    }

    const tree = await listTree(credentials, branch)
    if (tree.length > MAX_FILES) {
      return {
        error:
          `O repositório tem ${tree.length} arquivos, acima do limite de ` +
          `${MAX_FILES} para publicação direta.`,
      }
    }

    const files: DeployFile[] = []
    for (const entry of tree) {
      try {
        files.push({
          path: entry.path,
          content: await readFile(credentials, entry.path, branch),
        })
      } catch {
        // Arquivo binário ou ilegível: fica de fora em vez de derrubar tudo.
      }
    }

    const name =
      (project.preview_project_name as string | null) ??
      previewProjectName(project.name as string, project.id)

    const supabaseRef = project.supabase_project_ref as string | null

    const { deployment } = await publishSharedPreview(config, name, files, {
      branch,
      ...(supabaseRef
        ? { supabaseUrl: `https://${supabaseRef}.supabase.co` }
        : {}),
    })

    await supabase
      .from('projects')
      .update({
        preview_project_name: name,
        preview_url_shared: deployment.url,
        preview_updated_at: new Date().toISOString(),
      })
      .eq('id', project.id)
      .eq('user_id', user.id)

    revalidatePath(`/projects/${project.id}`)
    return { url: deployment.url, state: deployment.state }
  } catch (error) {
    return { error: toActionError(error) }
  }
}

/** Estado do preview compartilhado, sem republicar. */
export async function getSharedPreviewState(projectId: string): Promise<{
  configured: boolean
  url?: string
  state?: string
  updatedAt?: string
}> {
  const config = sharedPreviewConfig()
  if (!config) return { configured: false }

  try {
    const { project } = await requireProjectOwner(
      projectId,
      'id, user_id, preview_project_name, preview_url_shared, preview_updated_at'
    )

    const name = project.preview_project_name as string | null
    if (!name) return { configured: true }

    const deployment = await readSharedPreview(config, name)
    if (!deployment) {
      return {
        configured: true,
        ...(project.preview_url_shared
          ? { url: project.preview_url_shared as string }
          : {}),
      }
    }

    return {
      configured: true,
      url: deployment.url,
      state: deployment.state,
      ...(project.preview_updated_at
        ? { updatedAt: project.preview_updated_at as string }
        : {}),
    }
  } catch {
    return { configured: true }
  }
}
