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
  ShieldCheck,
  Boxes,
} from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { DeleteProjectDialog } from '@/components/projects/delete-project-dialog'
import { ScaffoldForm } from '@/components/projects/scaffold-form'
import { LiveGateBadge } from '@/components/projects/live-gate-badge'
import { TemplateUpdateCard } from '@/components/projects/template-update-card'
import { SecretsCard } from '@/components/projects/secrets-card'
import { LocalDevCard } from '@/components/projects/local-dev-card'
import { bootstrapCommand } from '@/lib/bootstrap/command'
import { TEMPLATE_VERSION } from '@/lib/templates/project-files'
import { CAPABILITIES, type CapabilityId } from '@/lib/capabilities'
import {
  ActivityFeed,
  type ActivityItem,
} from '@/components/projects/activity-feed'
import { CheckpointHistory } from '@/components/projects/checkpoint-history'
import { humanCheckpointStatus } from '@/lib/checkpoint/restore'
import type { CheckpointHistoryItem } from '@/actions/checkpoints'
import {
  connectGithubAccount,
  connectSupabaseAccount,
} from '@/actions/accounts'
import { cn } from '@/lib/utils'
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

/** Selo do estado de provisioning (independente do status funcional). */
const PSTATE = {
  ready: { label: 'READY', tone: 'text-up-ink', icon: CheckCircle2, spin: false },
  provisioning: { label: 'Provisionando', tone: 'text-wait-ink', icon: Loader2, spin: true },
  scaffolding: { label: 'Gerando scaffold', tone: 'text-wait-ink', icon: Loader2, spin: true },
  validating: { label: 'Validando', tone: 'text-wait-ink', icon: Loader2, spin: true },
  failed: { label: 'Falhou', tone: 'text-down-ink', icon: AlertCircle, spin: false },
  draft: { label: 'Rascunho', tone: 'text-muted', icon: AlertCircle, spin: false },
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

  const [{ data }, { data: activity }, { data: checkpointRows }] = await Promise.all([
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
    supabase
      .from('checkpoints')
      .select(
        'id, parent_checkpoint_id, summary, risk_level, push_status, integration_status, migrations, pr_number, created_at, restored_from_checkpoint_id',
      )
      .eq('project_id', id)
      .order('created_at', { ascending: false })
      .limit(50),
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

  // v3.1 finalização — Histórico: status técnico → humano (a UI nunca mostra
  // jargão de Git; ver "Detalhe da feature" no relatório).
  const checkpoints: CheckpointHistoryItem[] = (checkpointRows ?? []).map((r) => ({
    id: r.id as string,
    parentCheckpointId: (r.parent_checkpoint_id as string | null) ?? null,
    summary: r.summary as string,
    riskLevel: r.risk_level as CheckpointHistoryItem['riskLevel'],
    status: humanCheckpointStatus(
      r.push_status as Parameters<typeof humanCheckpointStatus>[0],
      r.integration_status as Parameters<typeof humanCheckpointStatus>[1],
    ),
    migrations: Array.isArray(r.migrations) ? (r.migrations as string[]) : [],
    prNumber: (r.pr_number as number | null) ?? null,
    createdAt: r.created_at as string,
    restoredFromCheckpointId: (r.restored_from_checkpoint_id as string | null) ?? null,
  }))

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
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 sm:gap-4">
        {/* Cabeçalho */}
        <header className="flex items-center gap-4 px-1">
          <Link
            href="/dashboard"
            className="bg-surface inline-flex shrink-0 items-center gap-2 rounded-[var(--radius-control)] px-3 py-2 text-sm font-medium transition-colors hover:opacity-80"
          >
            <ArrowLeft className="h-4 w-4" />
            Dashboard
          </Link>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-base font-semibold">{project.name}</h1>
              <span
                className={cn(
                  'inline-flex items-center gap-1 text-xs font-semibold',
                  state.tone,
                )}
              >
                <state.icon
                  className={cn('h-3.5 w-3.5', state.spin && 'animate-spin')}
                />
                {state.label}
              </span>
              {provisioned && <LiveGateBadge projectId={project.id} />}
            </div>
            {project.description && (
              <p className="text-muted truncate text-xs">{project.description}</p>
            )}
          </div>
          <div className="ml-auto">
            <DeleteProjectDialog
              projectId={project.id}
              projectName={project.name}
            />
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
            abrir o GitHub. Só aparece quando o projeto já usa checkpoint/daemon. */}
        {checkpoints.length > 0 && (
          <section className="bg-surface flex max-h-[60vh] min-h-0 flex-col overflow-hidden rounded-[var(--radius-inner)] p-4">
            <div className="mb-3 shrink-0">
              <h2 className="text-sm font-semibold">Histórico</h2>
              <p className="text-muted text-xs">
                Cada alteração pedida no seu editor. Publicação, CI e segurança
                acontecem em background — o GitHub é infraestrutura, não algo que
                você precisa abrir.
              </p>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              <CheckpointHistory projectId={project.id} items={checkpoints} />
            </div>
          </section>
        )}

        {/* Atividade */}
        <section className="bg-surface flex max-h-[60vh] min-h-0 flex-col overflow-hidden rounded-[var(--radius-inner)] p-4">
          <div className="mb-3 shrink-0">
            <h2 className="text-sm font-semibold">Atividade</h2>
            <p className="text-muted text-xs">
              Cada proposta do agente, com o pull request e os gates.
            </p>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <ActivityFeed
              items={(activity ?? []) as unknown as ActivityItem[]}
              repoFullName={project.github_repo_full_name}
            />
          </div>
        </section>
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
    <section className="bg-surface rounded-[var(--radius-inner)] p-4">
      <h2 className="mb-3 text-sm font-semibold">Projeto</h2>
      <dl className="grid gap-3 sm:grid-cols-2">
        <div>
          <dt className="text-muted mb-1 flex items-center gap-1.5 text-xs">
            <Boxes className="h-3.5 w-3.5" /> Capabilities
          </dt>
          <dd className="flex flex-wrap gap-1.5">
            {capabilities.length === 0 ? (
              <span className="text-ink text-sm">só o CORE</span>
            ) : (
              capabilities.map((id) => (
                <span
                  key={id}
                  className="bg-sunken text-ink rounded-full px-2 py-0.5 text-xs font-medium"
                >
                  {CAPABILITIES[id]?.title ?? id}
                </span>
              ))
            )}
          </dd>
        </div>
        <div>
          <dt className="text-muted mb-1 flex items-center gap-1.5 text-xs">
            <ShieldCheck className="h-3.5 w-3.5" /> Perfil de segurança
          </dt>
          <dd className="text-ink text-sm font-medium">
            {securityProfile ? (PROFILE_LABEL[securityProfile] ?? securityProfile) : '—'}
          </dd>
        </div>
        <div>
          <dt className="text-muted mb-1 text-xs">Scaffold</dt>
          <dd className="text-ink font-mono text-sm">{scaffoldVersion ?? '—'}</dd>
        </div>
        <div>
          <dt className="text-muted mb-1 text-xs">Security baseline</dt>
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
    <section className="bg-surface rounded-[var(--radius-inner)] p-4">
      <h2 className="text-sm font-semibold">
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
