import { notFound, redirect } from 'next/navigation'
import { headers } from 'next/headers'
import Link from 'next/link'
import type { LucideIcon } from 'lucide-react'
import {
  ArrowLeft,
  ExternalLink,
  CheckCircle2,
  AlertCircle,
  Loader2,
  TriangleAlert,
  Database,
  ShieldCheck,
  Boxes,
  History,
  Activity,
} from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { DeleteProjectDialog } from '@/components/projects/delete-project-dialog'
import { ScaffoldForm } from '@/components/projects/scaffold-form'
import { LiveGateBadge } from '@/components/projects/live-gate-badge'
import { TemplateUpdateCard } from '@/components/projects/template-update-card'
import { SecretsCard } from '@/components/projects/secrets-card'
import { LocalDevCard } from '@/components/projects/local-dev-card'
import { Pill, type PillTone } from '@/components/ui/pill'
import { bootstrapCommand } from '@/lib/bootstrap/command'
import { TEMPLATE_VERSION } from '@/lib/templates/project-files'
import { CAPABILITIES, type CapabilityId } from '@/lib/capabilities'
import {
  ActivityFeed,
  type ActivityItem,
} from '@/components/projects/activity-feed'
import { CheckpointHistory } from '@/components/projects/checkpoint-history'
import { listProjectCheckpoints } from '@/actions/checkpoints'
import {
  connectGithubAccount,
  connectSupabaseAccount,
} from '@/actions/accounts'
import type { Project } from '@/types/database'

/**
 * Página do projeto — control plane, NÃO IDE. Mostra o estado do projeto e a
 * única ação de desenvolvimento: o comando local. O desenvolvimento acontece na
 * máquina do dev (Claude/Codex + localhost), não aqui: por isso não há editor,
 * preview, terminal, companion nem controles de deploy.
 */
interface ProjectWithAccounts extends Project {
  github_accounts: { login: string; avatar_url: string | null } | null
  supabase_accounts: { org_name: string } | null
  provisioning_state?: string | null
  capabilities?: string[] | null
  security_profile?: string | null
  scaffold_version?: string | null
  security_baseline_version?: string | null
}

const PROFILE_LABEL: Record<string, string> = {
  simple: 'Simples',
  standard: 'Padrão',
  multitenant: 'Multi-tenant',
  sensitive: 'Sensível',
}

/**
 * Selo do estado de provisioning (independente do status funcional).
 * `satisfies` (não `Record<string, …>`) preserva as chaves LITERAIS —
 * `keyof typeof PSTATE` continua o union fechado de sempre, então
 * `PSTATE[pstate]` não vira `T | undefined` sob `noUncheckedIndexedAccess`.
 */
const PSTATE = {
  ready: { label: 'Estrutura pronta', tone: 'up', icon: CheckCircle2, spin: false },
  provisioning: { label: 'Provisionando', tone: 'wait', icon: Loader2, spin: true },
  scaffolding: { label: 'Gerando scaffold', tone: 'wait', icon: Loader2, spin: true },
  validating: { label: 'Validando', tone: 'wait', icon: Loader2, spin: true },
  failed: { label: 'Falhou', tone: 'down', icon: AlertCircle, spin: false },
  draft: { label: 'Rascunho', tone: 'neutral', icon: AlertCircle, spin: false },
} satisfies Record<string, { label: string; tone: PillTone; icon: LucideIcon; spin: boolean }>

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

  const [{ data }, { data: activity }, checkpointHistory] = await Promise.all([
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
    // v3.1 finalização — Histórico: cada checkpoint (pedido concluído) do
    // workflow local (checkpoint/daemon), RLS-scoped (checkpoints_owner_select).
    listProjectCheckpoints(id),
  ])

  if (!data) notFound()

  const project = data as unknown as ProjectWithAccounts
  const provisioned = Boolean(project.github_repo_full_name)
  const pstate = (project.provisioning_state ??
    (provisioned ? 'ready' : 'draft')) as keyof typeof PSTATE
  const state = PSTATE[pstate] ?? PSTATE.draft
  const templateBehind =
    provisioned && project.template_version !== TEMPLATE_VERSION

  const capabilities = (project.capabilities ?? []) as CapabilityId[]

  const checkpoints = checkpointHistory.items ?? []

  // Comando de bootstrap (device flow) — só o project-id, nada sensível.
  const configuredUrl = process.env.NEXT_PUBLIC_APP_URL
  const host = (await headers()).get('host') ?? 'localhost:3000'
  const baseUrl = configuredUrl
    ? configuredUrl.replace(/\/$/, '')
    : `${host.startsWith('localhost') ? 'http' : 'https'}://${host}`
  const bootstrapCmd = bootstrapCommand(project.id, baseUrl)

  const supabaseDashUrl = project.supabase_project_ref
    ? `https://supabase.com/dashboard/project/${project.supabase_project_ref}`
    : null
  const githubUrl = project.github_repo_full_name
    ? `https://github.com/${project.github_repo_full_name}`
    : null

  return (
    <div className="min-h-dvh p-3 sm:p-4">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 sm:gap-5">
        <Link
          href="/dashboard"
          className="text-muted hover:text-ink inline-flex w-fit shrink-0 items-center gap-1.5 px-1 text-xs font-medium transition-colors"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Dashboard
        </Link>

        {/* Cabeçalho — sticky: fica visível durante o scroll da página. `top`
            casa com o padding do wrapper (`p-3 sm:p-4`) pra manter a mesma
            distância da borda que já tinha em repouso; `z-10` garante que o
            conteúdo que rola por baixo nunca apareça por cima. Não cria
            scroll interno nenhum — quem rola continua sendo a página inteira
            (ver WorkspaceLayout/page.test.ts). */}
        <header className="bg-surface sticky top-3 z-10 rounded-[var(--radius-inner)] p-4 sm:top-4 sm:p-5">
          <div className="flex items-start gap-4">
            <div className="min-w-0 flex-1">
              <h1 className="text-ink truncate text-lg font-semibold tracking-tight sm:text-xl">
                {project.name}
              </h1>
              {project.description && (
                <p className="text-muted mt-0.5 truncate text-sm">
                  {project.description}
                </p>
              )}
              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                <Pill tone={state.tone} icon={state.icon} pulse={state.spin}>
                  {state.label}
                </Pill>
                {provisioned && <LiveGateBadge projectId={project.id} />}
              </div>
            </div>
            <div className="shrink-0">
              <DeleteProjectDialog
                projectId={project.id}
                projectName={project.name}
              />
            </div>
          </div>
        </header>

        {/* Provisionar (só antes de existir o repo) */}
        {!provisioned && (
          <ProvisionCard
            projectId={project.id}
            ready={Boolean(project.github_accounts)}
            failed={pstate === 'failed'}
          />
        )}

        {/* Integrações principais: GitHub + Supabase */}
        <div className="grid gap-3 sm:grid-cols-2">
          <IntegrationCard
            title="GitHub"
            subtitle="Repositório do código"
            connected={Boolean(project.github_accounts)}
            detail={
              project.github_accounts
                ? (project.github_repo_full_name ?? project.github_accounts.login)
                : null
            }
            href={githubUrl}
            linkLabel="Ver GitHub"
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
            href={supabaseDashUrl}
            linkLabel="Ver Supabase"
            action={async () => {
              'use server'
              await connectSupabaseAccount(id)
            }}
            actionLabel="Conectar Supabase"
          />
        </div>

        {/* Identidade do scaffold: capabilities, perfil, versões */}
        {provisioned && (
          <ProjectInfoCard
            capabilities={capabilities}
            securityProfile={project.security_profile ?? null}
            scaffoldVersion={project.scaffold_version ?? project.template_version}
            securityBaseline={project.security_baseline_version ?? null}
          />
        )}

        {/* Desenvolvimento local: o único caminho de dev */}
        {provisioned && <LocalDevCard command={bootstrapCmd} />}

        {templateBehind && (
          <TemplateUpdateCard
            projectId={project.id}
            projectVersion={project.template_version}
            latestVersion={TEMPLATE_VERSION}
          />
        )}

        {provisioned && <SecretsCard projectId={project.id} />}

        {/* Histórico (v3.1) — cada pedido concluído no editor local, sem precisar
            abrir o GitHub. Só aparece quando o projeto já usa checkpoint/daemon.
            Cresce com o conteúdo — é a PÁGINA que rola, nunca uma caixa interna
            (ver WorkspaceLayout: min-h-screen, não h-screen overflow-hidden). */}
        {provisioned && (
          <section className="bg-surface rounded-[var(--radius-inner)] p-4 sm:p-5">
            <SectionHeader
              icon={History}
              title="Histórico"
              subtitle="Alterações salvas no computador, envio e validação. O histórico atualiza automaticamente."
            />
            <CheckpointHistory projectId={project.id} items={checkpoints} />
          </section>
        )}

        {/* Atividade */}
        {(activity?.length ?? 0) > 0 && <section className="bg-surface rounded-[var(--radius-inner)] p-4 sm:p-5">
          <SectionHeader
            icon={Activity}
            title="Atividade anterior"
            subtitle="Propostas registradas antes do histórico de checkpoints."
          />
          <ActivityFeed
            items={(activity ?? []) as unknown as ActivityItem[]}
            repoFullName={project.github_repo_full_name}
          />
        </section>}
      </div>
    </div>
  )
}

/** Cabeçalho de seção consistente — ícone + título + subtítulo, mesma hierarquia
 *  em Histórico, Atividade e nas demais seções da tela do projeto. */
function SectionHeader({
  icon: Icon,
  title,
  subtitle,
}: {
  icon: LucideIcon
  title: string
  subtitle: string
}) {
  return (
    <div className="mb-3.5 flex shrink-0 items-start gap-2.5">
      <div className="bg-sunken flex size-7 shrink-0 items-center justify-center rounded-full">
        <Icon className="text-ink-soft size-3.5" />
      </div>
      <div className="min-w-0 pt-0.5">
        <h2 className="text-ink text-sm font-semibold">{title}</h2>
        <p className="text-muted mt-0.5 text-xs leading-relaxed">{subtitle}</p>
      </div>
    </div>
  )
}

function ProjectInfoCard({
  capabilities,
  securityProfile,
  scaffoldVersion,
  securityBaseline,
}: {
  capabilities: CapabilityId[]
  securityProfile: string | null
  scaffoldVersion: string | null
  securityBaseline: string | null
}) {
  return (
    <section className="bg-surface rounded-[var(--radius-inner)] p-4 sm:p-5">
      <SectionHeader icon={Boxes} title="Projeto" subtitle="Capabilities e perfil de segurança do scaffold." />
      <dl className="grid gap-4 sm:grid-cols-2">
        <div>
          <dt className="text-muted mb-1.5 flex items-center gap-1.5 text-xs font-medium">
            <Boxes className="h-3.5 w-3.5" /> Capabilities
          </dt>
          <dd className="flex flex-wrap gap-1.5">
            {capabilities.length === 0 ? (
              <span className="text-ink-soft text-sm">só o CORE</span>
            ) : (
              capabilities.map((id) => (
                <span
                  key={id}
                  className="bg-sunken text-ink rounded-full px-2.5 py-1 text-xs font-medium"
                >
                  {CAPABILITIES[id]?.title ?? id}
                </span>
              ))
            )}
          </dd>
        </div>
        <div>
          <dt className="text-muted mb-1.5 flex items-center gap-1.5 text-xs font-medium">
            <ShieldCheck className="h-3.5 w-3.5" /> Perfil de segurança
          </dt>
          <dd className="text-ink text-sm font-medium">
            {securityProfile ? (PROFILE_LABEL[securityProfile] ?? securityProfile) : '—'}
          </dd>
        </div>
        <div>
          <dt className="text-muted mb-1.5 text-xs font-medium">Scaffold</dt>
          <dd className="text-ink font-mono text-sm">{scaffoldVersion ?? '—'}</dd>
        </div>
        <div>
          <dt className="text-muted mb-1.5 text-xs font-medium">Security baseline</dt>
          <dd className="text-ink font-mono text-sm">{securityBaseline ?? '—'}</dd>
        </div>
      </dl>
    </section>
  )
}

function ProvisionCard({
  projectId,
  ready,
  failed,
}: {
  projectId: string
  ready: boolean
  failed: boolean
}) {
  return (
    <section className="bg-surface rounded-[var(--radius-inner)] p-4 sm:p-5">
      <h2 className="text-ink text-sm font-semibold">
        {failed ? 'Retomar provisionamento' : 'Provisionar'}
      </h2>
      <p className="text-muted mt-1 mb-3 text-xs">
        {failed
          ? 'Uma etapa anterior falhou. Retomar continua do ponto que parou, sem recriar o que já existe.'
          : 'Cria o repositório, o banco com RLS, os gates do CI e o baseline de segurança.'}
      </p>

      <ScaffoldForm projectId={projectId} disabled={!ready} />

      {!ready && (
        <p className="text-wait-ink mt-2.5 flex items-start gap-1.5 text-xs">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          Conecte o GitHub para habilitar.
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
  href,
  linkLabel,
  action,
  actionLabel,
}: {
  title: string
  subtitle: string
  connected: boolean
  detail: string | null
  href: string | null
  linkLabel: string
  action: () => Promise<void>
  actionLabel: string
}) {
  return (
    <section className="bg-surface rounded-[var(--radius-inner)] p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-ink text-sm font-medium">{title}</h3>
          <p className="text-muted text-xs">{subtitle}</p>
        </div>
        {connected ? (
          <Pill tone="up" icon={CheckCircle2} className="shrink-0">
            Conectado
          </Pill>
        ) : (
          <Database className="text-muted h-4 w-4 shrink-0" />
        )}
      </div>

      {connected ? (
        <div className="mt-2 flex items-center justify-between gap-2">
          {detail && (
            <p className="text-muted min-w-0 truncate font-mono text-xs">
              {detail}
            </p>
          )}
          {href && (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-muted hover:text-ink inline-flex shrink-0 items-center gap-1 text-xs font-medium"
            >
              {linkLabel}
              <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
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
