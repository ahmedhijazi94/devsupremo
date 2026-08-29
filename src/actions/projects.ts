'use server'

import { createClient } from '@/lib/supabase/server'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { decryptToken } from '@/lib/crypto'

const activateProjectSchema = z.object({
  projectId: z.string().uuid(),
})

export async function activateProject(
  projectId: string
): Promise<{ error?: string }> {
  const parsed = activateProjectSchema.safeParse({ projectId })
  if (!parsed.success) {
    return { error: 'ID de projeto inválido.' }
  }

  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) return { error: 'Não autorizado.' }

  // Verificar ownership (além do RLS)
  const { data: project } = await supabase
    .from('projects')
    .select('id')
    .eq('id', parsed.data.projectId)
    .eq('user_id', user.id)
    .single()

  if (!project) return { error: 'Projeto não encontrado.' }

  // Desativar todos os projetos do usuário
  const { error: deactivateError } = await supabase
    .from('projects')
    .update({ is_active: false })
    .eq('user_id', user.id)
    .neq('id', parsed.data.projectId)

  if (deactivateError) {
    return { error: 'Erro ao desativar projetos anteriores.' }
  }

  // Ativar o projeto selecionado
  const { error: activateError } = await supabase
    .from('projects')
    .update({ is_active: true })
    .eq('id', parsed.data.projectId)
    .eq('user_id', user.id)

  if (activateError) {
    return { error: 'Erro ao ativar projeto.' }
  }

  // Log de auditoria
  await supabase.from('audit_logs').insert({
    user_id: user.id,
    action: 'project.activate',
    resource_type: 'project',
    resource_id: parsed.data.projectId,
  })

  revalidatePath('/', 'layout')

  return {}
}

const createProjectSchema = z.object({
  name: z.string().min(2).max(50).regex(/^[a-z0-9-]+$/, {
    message: 'Apenas letras minúsculas, números e hífens.',
  }),
  description: z.string().max(200).optional(),
  githubAccountId: z.string().uuid().optional(),
  supabaseAccountId: z.string().uuid().optional(),
})

export async function createProject(
  formData: z.infer<typeof createProjectSchema>
): Promise<{ error?: string; projectId?: string }> {
  const parsed = createProjectSchema.safeParse(formData)
  if (!parsed.success) {
    const firstError = parsed.error.issues[0]
    return { error: firstError?.message ?? 'Dados inválidos.' }
  }

  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) return { error: 'Não autorizado.' }

  // Verificar ownership das contas
  if (parsed.data.githubAccountId) {
    const { data: ghAccount } = await supabase
      .from('github_accounts')
      .select('id')
      .eq('id', parsed.data.githubAccountId)
      .eq('user_id', user.id)
      .single()
    if (!ghAccount) return { error: 'Conta GitHub inválida.' }
  }

  if (parsed.data.supabaseAccountId) {
    const { data: sbAccount } = await supabase
      .from('supabase_accounts')
      .select('id')
      .eq('id', parsed.data.supabaseAccountId)
      .eq('user_id', user.id)
      .single()
    if (!sbAccount) return { error: 'Conta Supabase inválida.' }
  }

  // Criar projeto
  const { data: project, error } = await supabase
    .from('projects')
    .insert({
      user_id: user.id,
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      github_account_id: parsed.data.githubAccountId ?? null,
      supabase_account_id: parsed.data.supabaseAccountId ?? null,
      active_mcp: 'antigravity',
      active_branch: 'main',
      status: 'creating',
      is_active: false,
    })
    .select('id')
    .single()

  if (error ?? !project) return { error: 'Erro ao criar projeto.' }

  const createdProject = project as { id: string }

  // Log de auditoria
  await supabase.from('audit_logs').insert({
    user_id: user.id,
    action: 'project.create',
    resource_type: 'project',
    resource_id: createdProject.id,
    metadata: { name: parsed.data.name },
  })

  revalidatePath('/dashboard')
  return { projectId: createdProject.id }
}

export async function deleteProject(projectId: string): Promise<{ error?: string }> {
  const supabase = await createClient()

  // 1. Auth check
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Não autorizado.' }

  // 2. Fetch project
  const { data: project } = await supabase
    .from('projects')
    .select('*')
    .eq('id', projectId)
    .single()

  if (!project) return { error: 'Projeto não encontrado.' }
  if (project.user_id !== user.id) return { error: 'Acesso negado.' }

  const errors: string[] = []

  // 3. Delete from Supabase (if connected)
  if (project.supabase_project_ref && project.supabase_account_id) {
    const { data: sbAcc } = await supabase
      .from('supabase_accounts')
      .select('access_token_encrypted')
      .eq('id', project.supabase_account_id)
      .single()

    if (sbAcc) {
      try {
        const sbToken = decryptToken(sbAcc.access_token_encrypted)
        const sbRes = await fetch(`https://api.supabase.com/v1/projects/${project.supabase_project_ref}`, {
          method: 'DELETE',
          headers: {
            'Authorization': `Bearer ${sbToken}`,
            'Content-Type': 'application/json'
          }
        })
        
        if (!sbRes.ok && sbRes.status !== 404) {
          const err = await sbRes.text()
          console.error('Erro ao deletar projeto Supabase:', err)
          errors.push('Falha ao excluir projeto no Supabase.')
        }
      } catch (e) {
        console.error(e)
        errors.push('Falha ao autenticar com a API do Supabase.')
      }
    }
  }

  // 4. Delete from GitHub (if connected)
  if (project.github_repo_full_name && project.github_account_id) {
    const { data: ghAcc } = await supabase
      .from('github_accounts')
      .select('access_token_encrypted')
      .eq('id', project.github_account_id)
      .single()

    if (ghAcc) {
      try {
        const ghToken = decryptToken(ghAcc.access_token_encrypted)
        const ghRes = await fetch(`https://api.github.com/repos/${project.github_repo_full_name}`, {
          method: 'DELETE',
          headers: {
            'Authorization': `Bearer ${ghToken}`,
            'Accept': 'application/vnd.github.v3+json',
            'X-GitHub-Api-Version': '2022-11-28'
          }
        })
        
        if (!ghRes.ok && ghRes.status !== 404) {
          const err = await ghRes.text()
          console.error('Erro ao deletar repo GitHub:', err)
          if (ghRes.status === 403) {
            errors.push('Sem permissão para excluir repo no GitHub (reconecte a conta GitHub para conceder).')
          } else {
            errors.push('Falha ao excluir repositório no GitHub.')
          }
        }
      } catch (e) {
        console.error(e)
        errors.push('Falha ao autenticar com a API do GitHub.')
      }
    }
  }

  if (errors.length > 0) {
    return { error: errors.join(' ') }
  }

  // 5. Delete from Supremo Database
  const { error: dbError } = await supabase
    .from('projects')
    .delete()
    .eq('id', projectId)

  if (dbError) {
    console.error('Erro ao deletar do DB:', dbError)
    return { error: 'Falha ao remover o projeto do banco de dados local.' }
  }

  revalidatePath('/', 'layout')
  return {}
}

export async function createEmptyProject(name: string, description?: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Não autorizado.' }

  const { data, error } = await supabase
    .from('projects')
    .insert({
      user_id: user.id,
      name,
      description,
      status: 'creating',
    })
    .select('id')
    .single()

  if (error) {
    if (error.code === '23505') {
      return { error: 'Você já tem um projeto com este nome.' }
    }
    return { error: 'Falha ao criar o projeto.' }
  }

  revalidatePath('/', 'layout')
  return { data }
}
