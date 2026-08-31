import type { SupabaseClient } from '@supabase/supabase-js'
import { freshGithubToken } from '@/lib/github-token'
import { freshSupabaseToken } from '@/lib/supabase-token'
import { mcpDataClient } from './tokens'
import type { Json } from '@/types/database'

/**
 * Camada de acesso a dados das ferramentas de MCP.
 *
 * Regra que não se quebra: toda função exige `userId` e filtra por ele.
 * O cliente por baixo usa service role (não há cookie numa chamada de MCP,
 * logo o RLS não tem `auth.uid()` para avaliar), então o filtro por dono
 * aqui é a única fronteira entre contas. Nunca aceite um `projectId` sem
 * passar por `getProject`.
 */

export interface ProjectRecord {
  preview_project_name: string | null
  id: string
  user_id: string
  name: string
  description: string | null
  github_account_id: string | null
  supabase_account_id: string | null
  github_repo_full_name: string | null
  supabase_project_ref: string | null
  active_branch: string
  default_branch: string
  preview_url: string | null
  status: string
  is_active: boolean
  updated_at: string
  /** Tipo do app: decide a migration e os arquivos. Nulo (antigo) é 'solo'. */
  kind: string | null
  /** Versão do template com que a base foi escrita. Nulo em projeto antigo. */
  template_version: string | null
}

const PROJECT_COLUMNS =
  'id, user_id, name, description, github_account_id, supabase_account_id, ' +
  'github_repo_full_name, supabase_project_ref, active_branch, default_branch, ' +
  'preview_url, preview_project_name, status, is_active, updated_at, ' +
  'kind, template_version'

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NotFoundError'
  }
}

export class NotConfiguredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NotConfiguredError'
  }
}

function db(): SupabaseClient {
  return mcpDataClient()
}

// ─────────────────────────────────────────────────────────────
// Projetos
// ─────────────────────────────────────────────────────────────

export async function listProjects(userId: string): Promise<ProjectRecord[]> {
  const { data, error } = await db()
    .from('projects')
    .select(PROJECT_COLUMNS)
    .eq('user_id', userId)
    .order('updated_at', { ascending: false })

  if (error) throw new Error(`Falha ao listar projetos: ${error.message}`)
  return (data ?? []) as unknown as ProjectRecord[]
}

export async function getProject(
  userId: string,
  projectId: string,
): Promise<ProjectRecord> {
  const { data, error } = await db()
    .from('projects')
    .select(PROJECT_COLUMNS)
    .eq('id', projectId)
    .eq('user_id', userId)
    .maybeSingle()

  if (error) throw new Error(`Falha ao buscar projeto: ${error.message}`)
  if (!data) throw new NotFoundError('Projeto não encontrado.')
  return data as unknown as ProjectRecord
}

export async function getActiveProject(
  userId: string,
): Promise<ProjectRecord | null> {
  const { data, error } = await db()
    .from('projects')
    .select(PROJECT_COLUMNS)
    .eq('user_id', userId)
    .eq('is_active', true)
    .maybeSingle()

  if (error) throw new Error(`Falha ao buscar projeto ativo: ${error.message}`)
  return (data as unknown as ProjectRecord) ?? null
}

/**
 * Resolve o projeto alvo de uma ferramenta: o explícito, se veio, senão o ativo.
 * Em ambos os casos a checagem de dono acontece.
 */
export async function resolveProject(
  userId: string,
  projectId?: string,
): Promise<ProjectRecord> {
  if (projectId) return getProject(userId, projectId)

  const active = await getActiveProject(userId)
  if (!active) {
    throw new NotFoundError(
      'Nenhum projeto ativo. Passe projectId ou ative um projeto no painel.',
    )
  }
  return active
}

export async function setActiveProject(
  userId: string,
  projectId: string,
): Promise<ProjectRecord> {
  // Confirma o dono antes de qualquer escrita.
  const project = await getProject(userId, projectId)

  const { error: deactivateError } = await db()
    .from('projects')
    .update({ is_active: false })
    .eq('user_id', userId)
    .neq('id', projectId)

  if (deactivateError) {
    throw new Error(`Falha ao desativar projetos: ${deactivateError.message}`)
  }

  const { error: activateError } = await db()
    .from('projects')
    .update({ is_active: true })
    .eq('id', projectId)
    .eq('user_id', userId)

  if (activateError) {
    throw new Error(`Falha ao ativar projeto: ${activateError.message}`)
  }

  return { ...project, is_active: true }
}

export async function updateProject(
  userId: string,
  projectId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const { error } = await db()
    .from('projects')
    .update(patch)
    .eq('id', projectId)
    .eq('user_id', userId)

  if (error) throw new Error(`Falha ao atualizar projeto: ${error.message}`)
}

// ─────────────────────────────────────────────────────────────
// Credenciais dos provedores
// ─────────────────────────────────────────────────────────────

export interface GithubCredentials {
  token: string
  repoFullName: string
  owner: string
  repo: string
  branch: string
  defaultBranch: string
}

export async function getGithubCredentials(
  userId: string,
  project: ProjectRecord,
): Promise<GithubCredentials> {
  if (!project.github_account_id) {
    throw new NotConfiguredError(
      'Projeto sem conta GitHub vinculada. Conecte uma em /accounts.',
    )
  }
  if (!project.github_repo_full_name) {
    throw new NotConfiguredError(
      'Projeto ainda não provisionado no GitHub. Rode o scaffold primeiro.',
    )
  }

  const accountId = project.github_account_id
  const { data, error } = await db()
    .from('github_accounts')
    .select('access_token_encrypted, refresh_token_encrypted, token_expires_at')
    .eq('id', accountId)
    .eq('user_id', userId)
    .maybeSingle()

  if (error) throw new Error(`Falha ao ler conta GitHub: ${error.message}`)
  if (!data) throw new NotFoundError('Conta GitHub não encontrada.')

  const [owner, repo] = project.github_repo_full_name.split('/')
  if (!owner || !repo) {
    throw new Error(`Repositório inválido: ${project.github_repo_full_name}`)
  }

  // Renova o token de 8h pelo refresh quando expira. Sem isto, o agente
  // conectado de outra máquina falha com "Bad credentials" depois do prazo —
  // e "continuar de onde parou" morre junto.
  const token = await freshGithubToken(data, (update) =>
    db().from('github_accounts').update(update).eq('id', accountId).eq('user_id', userId),
  )

  return {
    token,
    repoFullName: project.github_repo_full_name,
    owner,
    repo,
    branch: project.active_branch || project.default_branch || 'main',
    defaultBranch: project.default_branch || 'main',
  }
}

export interface SupabaseCredentials {
  token: string
  projectRef: string
}

export async function getSupabaseCredentials(
  userId: string,
  project: ProjectRecord,
): Promise<SupabaseCredentials> {
  if (!project.supabase_account_id || !project.supabase_project_ref) {
    throw new NotConfiguredError(
      'Projeto sem banco Supabase vinculado. Conecte uma conta em /accounts.',
    )
  }

  const accountId = project.supabase_account_id
  const { data, error } = await db()
    .from('supabase_accounts')
    .select('access_token_encrypted, refresh_token_encrypted, token_expires_at')
    .eq('id', accountId)
    .eq('user_id', userId)
    .maybeSingle()

  if (error) throw new Error(`Falha ao ler conta Supabase: ${error.message}`)
  if (!data) throw new NotFoundError('Conta Supabase não encontrada.')

  // Renova o token de ~1h se expirou — senão migration/dado do MCP falham.
  const token = await freshSupabaseToken(data, (update) =>
    db().from('supabase_accounts').update(update).eq('id', accountId).eq('user_id', userId),
  )

  return { token, projectRef: project.supabase_project_ref }
}

// ─────────────────────────────────────────────────────────────
// Histórico e auditoria
// ─────────────────────────────────────────────────────────────

export interface MessageInput {
  projectId: string
  role: 'user' | 'assistant'
  content: string
  branch?: string | null
  prNumber?: number | null
  prUrl?: string | null
  checksUrl?: string | null
  previewUrl?: string | null
  commitSha?: string | null
  commitMessage?: string | null
  filesChanged?: Json | null
  pipelineStatus?: 'pending' | 'running' | 'passed' | 'failed' | null
  pipelineLog?: Json | null
  mcpUsed?: string | null
}

export async function recordMessage(
  userId: string,
  input: MessageInput,
): Promise<string> {
  const { data, error } = await db()
    .from('messages')
    .insert({
      project_id: input.projectId,
      user_id: userId,
      role: input.role,
      content: input.content,
      branch: input.branch ?? null,
      pr_number: input.prNumber ?? null,
      pr_url: input.prUrl ?? null,
      checks_url: input.checksUrl ?? null,
      preview_url: input.previewUrl ?? null,
      commit_sha: input.commitSha ?? null,
      commit_message: input.commitMessage ?? null,
      files_changed: input.filesChanged ?? null,
      pipeline_status: input.pipelineStatus ?? null,
      pipeline_log: input.pipelineLog ?? null,
      mcp_used: input.mcpUsed ?? null,
    })
    .select('id')
    .single()

  if (error) throw new Error(`Falha ao gravar mensagem: ${error.message}`)
  return data.id as string
}

export async function updateMessage(
  userId: string,
  messageId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const { error } = await db()
    .from('messages')
    .update(patch)
    .eq('id', messageId)
    .eq('user_id', userId)

  if (error) throw new Error(`Falha ao atualizar mensagem: ${error.message}`)
}

export async function logAudit(
  userId: string,
  action: string,
  resourceType: string,
  resourceId?: string | null,
  metadata?: Json,
): Promise<void> {
  const { error } = await db()
    .from('audit_logs')
    .insert({
      user_id: userId,
      action,
      resource_type: resourceType,
      resource_id: resourceId ?? null,
      metadata: metadata ?? null,
    })

  // Auditoria não pode derrubar a operação, mas a falha precisa aparecer.
  if (error) {
    console.error(`[audit] falha ao registrar ${action}: ${error.message}`)
  }
}

// ─────────────────────────────────────────────────────────────
// Pedidos de secret — o agente pede, o dono preenche no Supremo
// ─────────────────────────────────────────────────────────────

/**
 * Registra que o projeto precisa de uma env var (chave de API etc.). Guarda só
 * o PEDIDO — o valor nunca passa por aqui. Idempotente por (projeto, nome).
 */
export async function createSecretRequest(
  userId: string,
  projectId: string,
  name: string,
  description: string | null,
  isSecret: boolean,
): Promise<void> {
  const { error } = await db()
    .from('secret_requests')
    .upsert(
      {
        user_id: userId,
        project_id: projectId,
        name,
        description,
        is_secret: isSecret,
        status: 'pending',
      },
      { onConflict: 'project_id,name' },
    )

  if (error) {
    throw new Error(`Falha ao registrar o pedido de secret: ${error.message}`)
  }
}
