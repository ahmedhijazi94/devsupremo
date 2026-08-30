import { createClient } from '@/lib/supabase/server'
import { notFound, redirect } from 'next/navigation'
import { GitBranch, Database, Zap, ExternalLink, ArrowLeft, CheckCircle2, AlertCircle, Loader2 } from 'lucide-react'
import Link from 'next/link'
import { DeleteProjectDialog } from '@/components/projects/delete-project-dialog'
import { ScaffoldForm } from '@/components/projects/scaffold-form'
import { PreviewPanel } from '@/components/projects/preview-panel'
import { ActivityFeed, type ActivityItem } from '@/components/projects/activity-feed'
import type { Project } from '@/types/database'

/** Formato das relações que o select traz junto do projeto. */
interface ProjectWithAccounts extends Project {
  github_accounts: { login: string; avatar_url: string | null } | null
  supabase_accounts: { org_name: string } | null
}

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { id } = await params

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data } = await supabase
    .from('projects')
    .select(`
      *,
      github_accounts ( login, avatar_url ),
      supabase_accounts ( org_name )
    `)
    .eq('id', id)
    .eq('user_id', user.id)
    .maybeSingle()

  if (!data) notFound()

  const project = data as unknown as ProjectWithAccounts

  // Histórico do loop: cada proposta do agente com PR e resultado dos gates.
  const { data: activity } = await supabase
    .from('messages')
    .select(
      'id, role, content, branch, pr_number, pr_url, commit_sha, ' +
        'files_changed, pipeline_status, mcp_used, created_at'
    )
    .eq('project_id', id)
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(25)

  const isProvisioned = !!project.github_repo_full_name && !!project.supabase_project_ref
  const statusConfig = {
    active: { icon: CheckCircle2, label: 'Ativo', color: 'text-emerald-500 bg-emerald-500/10 border-emerald-500/20' },
    creating: { icon: Loader2, label: 'Criando...', color: 'text-amber-500 bg-amber-500/10 border-amber-500/20' },
    error: { icon: AlertCircle, label: 'Erro', color: 'text-red-500 bg-red-500/10 border-red-500/20' },
    archived: { icon: AlertCircle, label: 'Arquivado', color: 'text-muted-foreground bg-muted border-border' },
  }
  const statusCfg = statusConfig[project.status as keyof typeof statusConfig] ?? statusConfig.active
  const StatusIcon = statusCfg.icon

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-start gap-4">
        <Link
          href="/projects"
          className="mt-1 p-1.5 rounded-lg border hover:bg-accent transition-colors text-muted-foreground hover:text-foreground shrink-0"
        >
          <ArrowLeft className="w-4 h-4" />
        </Link>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-2xl font-bold truncate">{project.name}</h1>
            <span className={`inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full border ${statusCfg.color}`}>
              <StatusIcon className={`w-3 h-3 ${project.status === 'creating' ? 'animate-spin' : ''}`} />
              {statusCfg.label}
            </span>
          </div>
          {project.description && (
            <p className="text-muted-foreground mt-1 text-sm">{project.description}</p>
          )}
          {project.github_repo_full_name && (
            <a
              href={`https://github.com/${project.github_repo_full_name}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground mt-2 transition-colors"
            >
              <GitBranch className="w-3.5 h-3.5" />
              {project.github_repo_full_name}
              <ExternalLink className="w-3 h-3" />
            </a>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {project.preview_url && (
            <a
              href={project.preview_url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-lg border bg-background px-3 py-2 text-sm font-medium hover:bg-accent transition-colors"
            >
              <ExternalLink className="w-4 h-4" />
              Preview
            </a>
          )}
          <DeleteProjectDialog projectId={project.id} projectName={project.name} />
        </div>
      </div>

      {/* Live Preview — destaque principal */}
      {isProvisioned ? (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-base font-semibold flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                Live Preview
              </h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                Ambiente recriado em tempo real via WebContainers. HMR ativo — cada commit reflete instantaneamente.
              </p>
            </div>
          </div>
          <PreviewPanel repoFullName={project.github_repo_full_name} projectId={project.id} />
        </div>
      ) : (
        /* Scaffold CTA */
        <div className="border-2 border-dashed border-violet-500/25 bg-gradient-to-br from-violet-500/5 to-blue-500/5 rounded-xl p-8 flex flex-col items-center justify-center text-center space-y-4">
          <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-violet-500 to-blue-600 flex items-center justify-center shadow-md">
            <Zap className="w-6 h-6 text-white" />
          </div>
          <div>
            <h3 className="text-lg font-semibold">Provisionar Infraestrutura</h3>
            <p className="text-sm text-muted-foreground max-w-md mx-auto mt-1.5">
              Gere o repositório GitHub, banco de dados Supabase com RLS, configurações de segurança e inicie o desenvolvimento em segundos.
            </p>
          </div>
          <ScaffoldForm
            projectId={project.id}
            disabled={!project.github_accounts || !project.supabase_accounts}
          />
          {(!project.github_accounts || !project.supabase_accounts) && (
            <p className="text-xs text-amber-500 flex items-center gap-1.5">
              <AlertCircle className="w-3.5 h-3.5" />
              Conecte as duas integrações abaixo para habilitar o scaffolding.
            </p>
          )}
        </div>
      )}

      {/* Integration cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* GitHub */}
        <div className="border bg-card rounded-xl p-5 space-y-4">
          <div className="flex items-center gap-2.5 pb-3 border-b">
            <div className="w-7 h-7 rounded-lg bg-zinc-900 dark:bg-zinc-800 flex items-center justify-center">
              <svg className="w-4 h-4 text-white" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
              </svg>
            </div>
            <div>
              <h2 className="text-sm font-semibold">GitHub</h2>
              <p className="text-[11px] text-muted-foreground">Repositório do código</p>
            </div>
            {project.github_accounts && (
              <span className="ml-auto text-[11px] text-emerald-500 flex items-center gap-1">
                <CheckCircle2 className="w-3 h-3" /> Conectado
              </span>
            )}
          </div>

          {project.github_accounts ? (
            <div className="flex items-center gap-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={project.github_accounts.avatar_url ?? ''}
                alt="GitHub"
                className="w-8 h-8 rounded-full ring-1 ring-border"
              />
              <div>
                <p className="text-sm font-medium">{project.github_accounts.login}</p>
                <p className="text-xs text-muted-foreground">
                  {project.github_repo_full_name ?? 'Repositório ainda não criado'}
                </p>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">Conecte sua conta para criar e gerir o repositório automaticamente.</p>
              <form action={async () => {
                'use server'
                const { connectGithubAccount } = await import('@/actions/accounts')
                await connectGithubAccount(project.id)
              }}>
                <button type="submit" className="rounded-lg bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 px-4 py-2 text-sm font-medium hover:opacity-90 transition-opacity">
                  Conectar GitHub
                </button>
              </form>
            </div>
          )}
        </div>

        {/* Supabase */}
        <div className="border bg-card rounded-xl p-5 space-y-4">
          <div className="flex items-center gap-2.5 pb-3 border-b">
            <div className="w-7 h-7 rounded-lg bg-[#1C1C1C] flex items-center justify-center">
              <svg className="w-4 h-4 text-[#3ECF8E]" viewBox="0 0 24 24" fill="currentColor">
                <path d="M11.9 1.036c-.015-.986-1.26-1.41-1.874-.637L.764 12.05C.09 12.886.725 14.10 1.764 14.10h9.823l.013 8.864c.015.986 1.26 1.41 1.874.637l9.262-11.652c.673-.835.038-2.053-1.002-2.053h-9.823L11.9 1.036z"/>
              </svg>
            </div>
            <div>
              <h2 className="text-sm font-semibold">Supabase</h2>
              <p className="text-[11px] text-muted-foreground">Banco de dados + Auth</p>
            </div>
            {project.supabase_accounts && (
              <span className="ml-auto text-[11px] text-emerald-500 flex items-center gap-1">
                <CheckCircle2 className="w-3 h-3" /> Conectado
              </span>
            )}
          </div>

          {project.supabase_accounts ? (
            <div>
              <p className="text-sm font-medium">Org: {project.supabase_accounts.org_name}</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Ref: {project.supabase_project_ref ?? 'Projeto Supabase ainda não criado'}
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">Conecte sua conta para provisionar o banco com RLS automático.</p>
              <form action={async () => {
                'use server'
                const { connectSupabaseAccount } = await import('@/actions/accounts')
                await connectSupabaseAccount(project.id)
              }}>
                <button type="submit" className="rounded-lg bg-[#3ECF8E] text-black px-4 py-2 text-sm font-medium hover:bg-[#3ECF8E]/90 transition-colors">
                  Conectar Supabase
                </button>
              </form>
            </div>
          )}
        </div>
      </div>

      {/* Histórico de mudanças */}
      <section className="border bg-card rounded-xl p-5 space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold">Atividade</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Toda proposta do agente, com o pull request e o resultado dos gates.
            </p>
          </div>
          {project.github_repo_full_name && (
            <a
              href={`https://github.com/${project.github_repo_full_name}/pulls`}
              target="_blank"
              rel="noopener noreferrer"
              className="shrink-0 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
            >
              Ver no GitHub
            </a>
          )}
        </div>

        <ActivityFeed
          items={(activity ?? []) as unknown as ActivityItem[]}
          repoFullName={project.github_repo_full_name}
        />
      </section>
    </div>
  )
}
