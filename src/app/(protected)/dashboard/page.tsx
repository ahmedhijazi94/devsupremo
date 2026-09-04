import { redirect } from 'next/navigation'
import Link from 'next/link'
import {
  Plus,
  FolderOpen,
  GitPullRequest,
  ShieldCheck,
  ArrowRight,
} from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { Card, CardTitle, CardNote, Stat } from '@/components/ui/card'
import { ButtonLink } from '@/components/ui/button'
import { Pill } from '@/components/ui/pill'
import { ProjectCard } from '@/components/dashboard/project-card'
import { Onboarding } from '@/components/dashboard/onboarding'
import { isSupabaseOAuthAvailable } from '@/actions/accounts'
import { formatRelativeTime } from '@/lib/utils'

export default async function DashboardPage() {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const [
    { data: projects },
    github,
    supabaseAccounts,
    { data: changes },
    supabaseOAuth,
  ] = await Promise.all([
    supabase
      .from('projects')
      .select('*')
      .eq('user_id', user.id)
      .order('updated_at', { ascending: false }),
    supabase
      .from('github_accounts')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.id),
    supabase
      .from('supabase_accounts')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.id),
    supabase
      .from('messages')
      .select('id, content, pipeline_status, created_at, project_id, pr_number')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(6),
    isSupabaseOAuthAvailable(),
  ])

  const projectList = projects ?? []
  const changeList = changes ?? []

  // Integrações principais do control plane v2: GitHub + Supabase.
  const connections = {
    github: (github.count ?? 0) > 0,
    supabase: (supabaseAccounts.count ?? 0) > 0,
    supabaseOAuth,
  }

  const needsSetup = !connections.github || !connections.supabase

  const provisioned = projectList.filter((p) => p.github_repo_full_name).length
  const green = changeList.filter((c) => c.pipeline_status === 'passed').length

  return (
    <div className="space-y-3 sm:space-y-4">
      {needsSetup && <Onboarding status={connections} />}

      {/* Cabeçalho */}
      <Card className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <CardTitle className="text-xl">Painel</CardTitle>
          <CardNote className="mt-1">
            {projectList.length === 0
              ? 'Nenhum projeto ainda'
              : `${projectList.length} projeto${projectList.length > 1 ? 's' : ''} · ${provisioned} provisionado${provisioned === 1 ? '' : 's'}`}
          </CardNote>
        </div>

        <ButtonLink href="/projects/new">
          <Plus className="h-4 w-4" />
          Novo projeto
        </ButtonLink>
      </Card>

      {/* Números */}
      <div className="grid gap-3 sm:gap-4 md:grid-cols-3">
        <Stat
          label="Projetos"
          value={projectList.length}
          icon={<FolderOpen className="h-5 w-5" />}
          footer={
            <Link
              href="/projects"
              className="group inline-flex items-center gap-2 text-sm font-medium"
            >
              Ver todos
              <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
            </Link>
          }
        />

        <Stat
          label="Mudanças propostas"
          value={changeList.length}
          {...(green > 0
            ? {
                delta: {
                  value: `${green} verde${green > 1 ? 's' : ''}`,
                  direction: 'up' as const,
                },
              }
            : {})}
          icon={<GitPullRequest className="h-5 w-5" />}
          footer={
            <p className="text-muted text-sm">
              Cada uma passou por pull request e gates.
            </p>
          }
        />

        <Stat
          label="Contas conectadas"
          value={
            (connections.github ? 1 : 0) + (connections.supabase ? 1 : 0)
          }
          icon={<ShieldCheck className="h-5 w-5" />}
          footer={
            <Link
              href="/accounts"
              className="group inline-flex items-center gap-2 text-sm font-medium"
            >
              Gerenciar
              <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
            </Link>
          }
        />
      </div>

      {/* Projetos e atividade */}
      <div className="grid gap-3 sm:gap-4 xl:grid-cols-[1fr_380px]">
        <Card>
          <div className="mb-5 flex items-center justify-between gap-4">
            <div>
              <CardTitle>Seus projetos</CardTitle>
              <CardNote className="mt-0.5">
                Repositório, banco e preview de cada um.
              </CardNote>
            </div>
            {projectList.length > 0 && (
              <Link
                href="/projects"
                className="text-muted hover:text-ink shrink-0 text-sm font-medium transition-colors"
              >
                Ver todos
              </Link>
            )}
          </div>

          {projectList.length === 0 ? (
            <div className="bg-sunken rounded-[var(--radius-inner)] px-6 py-12 text-center">
              <p className="font-medium">Nenhum projeto ainda</p>
              <CardNote className="mx-auto mt-1.5 max-w-sm">
                Um projeto novo já nasce com repositório, banco com RLS, gates
                no CI e preview publicado.
              </CardNote>
              <ButtonLink href="/projects/new" className="mt-5" size="sm">
                <Plus className="h-4 w-4" />
                Criar projeto
              </ButtonLink>
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {projectList.slice(0, 6).map((project) => (
                <ProjectCard key={project.id} project={project} />
              ))}
            </div>
          )}
        </Card>

        <Card>
          <CardTitle>Últimas mudanças</CardTitle>
          <CardNote className="mt-0.5 mb-5">
            Propostas do agente, com o resultado dos gates.
          </CardNote>

          {changeList.length === 0 ? (
            <div className="bg-sunken rounded-[var(--radius-inner)] px-5 py-10 text-center">
              <CardNote>
                Abra um{' '}
                <Link href="/projects" className="underline underline-offset-2">
                  projeto
                </Link>{' '}
                e peça a primeira alteração ao seu agente.
              </CardNote>
            </div>
          ) : (
            <ul className="space-y-2.5">
              {changeList.map((change) => (
                <li
                  key={change.id}
                  className="bg-sunken flex items-start gap-3 rounded-[var(--radius-inner)] p-3.5"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {change.content}
                    </p>
                    <p className="text-muted mt-0.5 text-xs">
                      {change.pr_number ? `PR #${change.pr_number} · ` : ''}
                      {formatRelativeTime(change.created_at)}
                    </p>
                  </div>
                  <GateBadge status={change.pipeline_status} />
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  )
}

function GateBadge({ status }: { status: string | null }) {
  if (status === 'passed') return <Pill tone="up">verde</Pill>
  if (status === 'failed') return <Pill tone="down">vermelho</Pill>
  if (status === 'running' || status === 'pending') {
    return <Pill tone="wait">rodando</Pill>
  }
  return <Pill>—</Pill>
}
