import { notFound, redirect } from 'next/navigation'
import { headers } from 'next/headers'
import Link from 'next/link'
import {
  ArrowLeft,
  ExternalLink,
  CheckCircle2,
  AlertCircle,
  Loader2,
  TriangleAlert,
  Database,
} from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { DeleteProjectDialog } from '@/components/projects/delete-project-dialog'
import { ScaffoldForm } from '@/components/projects/scaffold-form'
import { WorkspaceTabs } from '@/components/projects/workspace-tabs'
import { WorkspaceShell } from '@/components/projects/workspace-shell'
import { LiveGateBadge } from '@/components/projects/live-gate-badge'
import { TemplateUpdateCard } from '@/components/projects/template-update-card'
import { SecretsCard } from '@/components/projects/secrets-card'
import { LocalDevCard } from '@/components/projects/local-dev-card'
import { bootstrapCommand } from '@/lib/bootstrap/command'
import { TEMPLATE_VERSION } from '@/lib/templates/project-files'
import {
  ActivityFeed,
  type ActivityItem,
} from '@/components/projects/activity-feed'
import {
  connectGithubAccount,
  connectSupabaseAccount,
} from '@/actions/accounts'
import { cn } from '@/lib/utils'
import type { Project } from '@/types/database'

/** Formato das relações que o select traz junto do projeto. */
interface ProjectWithAccounts extends Project {
  github_accounts: { login: string; avatar_url: string | null } | null
  supabase_accounts: { org_name: string } | null
}

const STATUS = {
  active: { icon: CheckCircle2, label: 'Ativo', tone: 'text-up-ink' },
  creating: { icon: Loader2, label: 'Criando', tone: 'text-wait-ink' },
  error: { icon: AlertCircle, label: 'Erro', tone: 'text-down-ink' },
  archived: { icon: AlertCircle, label: 'Arquivado', tone: 'text-muted' },
} as const

export default async function ProjectPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const supabase = await createClient()
  const { id } = await params

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const [{ data }, { data: activity }] = await Promise.all([
    supabase
      .from('projects')
      .select(
        `*, github_accounts ( login, avatar_url ), supabase_accounts ( org_name )`,
      )
      .eq('id', id)
      .eq('user_id', user.id)
      .maybeSingle(),
    supabase
      .from('messages')
      .select(
        'id, role, content, branch, pr_number, pr_url, commit_sha, ' +
          'files_changed, pipeline_status, mcp_used, created_at',
      )
      .eq('project_id', id)
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(25),
  ])

  if (!data) notFound()

  const project = data as unknown as ProjectWithAccounts
  const provisioned = Boolean(project.github_repo_full_name)
  const status = STATUS[project.status] ?? STATUS.active

  // Comando de bootstrap (device flow) — só o project-id, nada sensível.
  const configuredUrl = process.env.NEXT_PUBLIC_APP_URL
  const host = (await headers()).get('host') ?? 'localhost:3000'
  const baseUrl = configuredUrl
    ? configuredUrl.replace(/\/$/, '')
    : `${host.startsWith('localhost') ? 'http' : 'https'}://${host}`
  const bootstrapCmd = bootstrapCommand(project.id, baseUrl)
  // A versão gravada é o gatilho barato do selo; a conferência precisa vem só
  // quando o usuário abre o cartão. Projeto antigo (versão nula) também está
  // atrás, por definição.
  const templateBehind =
    provisioned && project.template_version !== TEMPLATE_VERSION

  return (
    // Tela cheia. h-dvh (não h-screen) para o celular não esconder o rodapé
    // atrás da barra do navegador.
    <div className="h-dvh p-3 sm:p-4">
      <div className="bg-surface flex h-full flex-col gap-3 rounded-[var(--radius-card)] p-3 sm:gap-4 sm:p-4">
        {/* Cabeçalho */}
        <header className="flex shrink-0 items-center gap-4 px-2 pt-1">
          <Link
            href="/dashboard"
            className="bg-sunken inline-flex shrink-0 items-center gap-2 rounded-[var(--radius-control)] px-3 py-2 text-sm font-medium transition-colors hover:opacity-80"
          >
            <ArrowLeft className="h-4 w-4" />
            Dashboard
          </Link>

          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-base font-semibold">
                {project.name}
              </h1>
              <span
                className={cn(
                  'inline-flex items-center gap-1 text-xs font-medium',
                  status.tone,
                )}
              >
                <status.icon
                  className={cn(
                    'h-3.5 w-3.5',
                    project.status === 'creating' && 'animate-spin',
                  )}
                />
                {status.label}
              </span>
              {provisioned && <LiveGateBadge projectId={project.id} />}
            </div>
            {project.github_repo_full_name && (
              <a
                href={`https://github.com/${project.github_repo_full_name}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-muted hover:text-ink inline-flex items-center gap-1 text-xs transition-colors"
              >
                {project.github_repo_full_name}
                <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </div>

          <div className="ml-auto">
            <DeleteProjectDialog
              projectId={project.id}
              projectName={project.name}
            />
          </div>
        </header>

        {/* Workspace — lado a lado no desktop, abas no celular. */}
        <WorkspaceShell
          sidebar={
            <>
              {!provisioned && (
              <ProvisionCard
                projectId={project.id}
                githubOwner={project.github_accounts?.login ?? null}
                ready={Boolean(project.github_accounts)}
              />
            )}

            <IntegrationCard
              title="GitHub"
              subtitle="Repositório do código"
              connected={Boolean(project.github_accounts)}
              detail={
                project.github_accounts
                  ? (project.github_repo_full_name ??
                    project.github_accounts.login)
                  : null
              }
              action={async () => {
                'use server'
                await connectGithubAccount(id)
              }}
              actionLabel="Conectar GitHub"
            />

            <IntegrationCard
              title="Supabase"
              subtitle="Banco de dados e login"
              connected={Boolean(project.supabase_accounts)}
              detail={
                project.supabase_accounts
                  ? (project.supabase_project_ref ??
                    project.supabase_accounts.org_name)
                  : null
              }
              action={async () => {
                'use server'
                await connectSupabaseAccount(id)
              }}
              actionLabel="Conectar Supabase"
            />

            {templateBehind && (
              <TemplateUpdateCard
                projectId={project.id}
                projectVersion={project.template_version}
                latestVersion={TEMPLATE_VERSION}
              />
            )}

            {provisioned && <LocalDevCard command={bootstrapCmd} />}

            {provisioned && <SecretsCard projectId={project.id} />}

            <section className="bg-surface flex min-h-0 flex-1 flex-col overflow-hidden rounded-[var(--radius-inner)] p-4">
              <div className="mb-3 shrink-0">
                <h2 className="text-sm font-semibold">Atividade</h2>
                <p className="text-muted text-xs">
                  Cada proposta do agente, com o pull request e os gates.
                </p>
              </div>
              {/* A lista rola dentro do cartão, sem vazar pela borda. */}
              <div className="min-h-0 flex-1 overflow-y-auto">
                <ActivityFeed
                  items={(activity ?? []) as unknown as ActivityItem[]}
                  repoFullName={project.github_repo_full_name}
                />
              </div>
            </section>
            </>
          }
          workspace={
            <WorkspaceTabs
              projectId={project.id}
              repoFullName={project.github_repo_full_name}
              provisioned={provisioned}
            />
          }
        />
      </div>
    </div>
  )
}

function ProvisionCard({
  projectId,
  githubOwner,
  ready,
}: {
  projectId: string
  githubOwner: string | null
  ready: boolean
}) {
  return (
    <section className="bg-surface rounded-[var(--radius-inner)] p-4">
      <h2 className="text-sm font-semibold">Provisionar</h2>
      <p className="text-muted mt-1 mb-3 text-xs">
        Cria o repositório, o banco com RLS, os gates do CI e o preview.
      </p>

      <ScaffoldForm
        projectId={projectId}
        disabled={!ready}
        githubOwner={githubOwner}
      />

      {!ready && (
        <p className="text-wait-ink mt-2.5 flex items-start gap-1.5 text-xs">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          Conecte o GitHub abaixo para habilitar.
        </p>
      )}
    </section>
  )
}

function IntegrationCard({
  title,
  subtitle,
  connected,
  detail,
  action,
  actionLabel,
}: {
  title: string
  subtitle: string
  connected: boolean
  detail: string | null
  action: () => Promise<void>
  actionLabel: string
}) {
  return (
    <section className="bg-surface rounded-[var(--radius-inner)] p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-medium">{title}</h3>
          <p className="text-muted text-xs">{subtitle}</p>
        </div>

        {connected ? (
          <span className="text-up-ink inline-flex shrink-0 items-center gap-1 text-xs font-medium">
            <CheckCircle2 className="h-3.5 w-3.5" />
            Conectado
          </span>
        ) : (
          <Database className="text-muted h-4 w-4 shrink-0" />
        )}
      </div>

      {connected ? (
        detail && (
          <p className="text-muted mt-2 truncate font-mono text-xs">{detail}</p>
        )
      ) : (
        <form action={action} className="mt-3">
          <button
            type="submit"
            className="hover:bg-sunken inline-flex h-8 items-center rounded-[var(--radius-control)] px-3 text-xs font-medium transition-colors"
          >
            {actionLabel}
          </button>
        </form>
      )}
    </section>
  )
}
