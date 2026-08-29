import { createClient } from '@/lib/supabase/server'
import { notFound } from 'next/navigation'
import { GitBranch, Database, Shield, Zap, ExternalLink } from 'lucide-react'
import { DeleteProjectDialog } from '@/components/projects/delete-project-dialog'

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { id } = await params

  const { data: project } = await supabase
    .from('projects')
    .select(`
      *,
      github_accounts ( login, avatar_url ),
      supabase_accounts ( org_name )
    `)
    .eq('id', id)
    .single()

  if (!project) notFound()

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">{project.name}</h1>
          {project.description && (
            <p className="text-muted-foreground mt-1">{project.description}</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {project.preview_url && (
            <a
              href={project.preview_url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-lg border bg-background px-4 py-2 text-sm font-medium hover:bg-accent transition-colors"
            >
              <ExternalLink className="w-4 h-4" /> Preview
            </a>
          )}
          <DeleteProjectDialog projectId={project.id} projectName={project.name} />
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* GitHub Integration */}
        <div className="border bg-card rounded-xl p-5 space-y-4">
          <div className="flex items-center gap-2 pb-2 border-b">
            <GitBranch className="w-5 h-5" />
            <h2 className="text-lg font-semibold">Repositório GitHub</h2>
          </div>
          
          {project.github_accounts ? (
            <div className="space-y-3">
              <div className="flex items-center gap-3">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={project.github_accounts.avatar_url} alt="GitHub" className="w-8 h-8 rounded-full" />
                <div>
                  <p className="text-sm font-medium">Conectado como {project.github_accounts.login}</p>
                  <p className="text-xs text-muted-foreground">
                    {project.github_repo_full_name || 'Nenhum repositório criado ainda'}
                  </p>
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">Conecte sua conta do GitHub para gerar o código fonte deste projeto.</p>
              <form action={async () => {
                'use server'
                const { connectGithubAccount } = await import('@/actions/accounts')
                await connectGithubAccount(project.id)
              }}>
                <button type="submit" className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors">
                  Conectar GitHub
                </button>
              </form>
            </div>
          )}
        </div>

        {/* Supabase Integration */}
        <div className="border bg-card rounded-xl p-5 space-y-4">
          <div className="flex items-center gap-2 pb-2 border-b">
            <Database className="w-5 h-5 text-[#3ECF8E]" />
            <h2 className="text-lg font-semibold">Banco de Dados (Supabase)</h2>
          </div>
          
          {project.supabase_accounts ? (
            <div className="space-y-3">
              <div className="flex flex-col gap-1">
                <p className="text-sm font-medium">Conectado na Org: {project.supabase_accounts.org_name}</p>
                <p className="text-xs text-muted-foreground">
                  Ref: {project.supabase_project_ref || 'Nenhum projeto Supabase criado ainda'}
                </p>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">Conecte sua conta do Supabase para provisionar o banco de dados e as políticas RLS.</p>
              <form action={async () => {
                'use server'
                const { connectSupabaseAccount } = await import('@/actions/accounts')
                await connectSupabaseAccount(project.id)
              }}>
                <button type="submit" className="rounded-lg bg-[#3ECF8E] px-4 py-2 text-sm font-medium text-black hover:bg-[#3ECF8E]/90 transition-colors">
                  Conectar Supabase
                </button>
              </form>
            </div>
          )}
        </div>
      </div>

      {/* Provision Action */}
      {(!project.github_repo_full_name || !project.supabase_project_ref) && (
        <div className="border border-blue-500/20 bg-blue-500/5 rounded-xl p-6 flex flex-col items-center justify-center text-center space-y-4">
          <Zap className="w-8 h-8 text-blue-500" />
          <div>
            <h3 className="text-lg font-semibold">Provisionar Infraestrutura</h3>
            <p className="text-sm text-muted-foreground max-w-md mx-auto mt-1">
              Gere o repositório, banco de dados, regras RLS e policies de segurança para iniciar o desenvolvimento.
            </p>
          </div>
          <form action={async () => {
            'use server'
            const { scaffoldProject } = await import('@/actions/scaffold')
            await scaffoldProject(project.id)
          }}>
            <button 
              type="submit"
              disabled={!project.github_accounts || !project.supabase_accounts}
              className="rounded-lg bg-blue-500 px-6 py-2 text-sm font-bold text-white hover:bg-blue-600 transition-colors disabled:opacity-50"
            >
              Rodar Scaffolding
            </button>
          </form>
          {(!project.github_accounts || !project.supabase_accounts) && (
            <p className="text-xs text-muted-foreground">Conecte as duas contas acima para habilitar o scaffolding.</p>
          )}
        </div>
      )}
    </div>
  )
}
