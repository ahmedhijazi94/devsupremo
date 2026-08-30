import { redirect } from 'next/navigation'
import Link from 'next/link'
import {
  Settings,
  User,
  KeyRound,
  GitBranch,
  Database,
  ArrowRight,
} from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { Card, CardTitle, CardNote } from '@/components/ui/card'

export const metadata = {
  title: 'Configurações — Supremo',
}

export default async function SettingsPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const [
    { count: githubCount },
    { count: supabaseCount },
    { count: tokenCount },
  ] = await Promise.all([
    supabase
      .from('github_accounts')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.id),
    supabase
      .from('supabase_accounts')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.id),
    supabase
      .from('mcp_tokens')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.id)
      .is('revoked_at', null),
  ])

  const links = [
    {
      href: '/accounts',
      icon: GitBranch,
      title: 'Contas conectadas',
      description: `${githubCount ?? 0} GitHub · ${supabaseCount ?? 0} Supabase`,
    },
    {
      href: '/mcps',
      icon: KeyRound,
      title: 'Tokens de MCP',
      description: `${tokenCount ?? 0} token${tokenCount === 1 ? '' : 's'} ativo${tokenCount === 1 ? '' : 's'}`,
    },
  ]

  return (
    <div className="space-y-3 sm:space-y-4">
      <Card>
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <Settings className="text-ink h-6 w-6" />
          Configurações
        </h1>
        <p className="text-muted mt-1.5">Sua conta, integrações e acessos.</p>
      </Card>

      <Card className="space-y-4">
        <div className="flex items-center gap-2">
          <User className="text-ink h-4 w-4" />
          <h2 className="font-semibold">Perfil</h2>
        </div>
        <dl className="grid gap-3 sm:grid-cols-2">
          <div>
            <dt className="text-muted text-xs font-medium tracking-wide uppercase">
              Nome
            </dt>
            <dd className="mt-0.5 text-sm">
              {(user.user_metadata?.name as string | undefined) ?? '—'}
            </dd>
          </div>
          <div>
            <dt className="text-muted text-xs font-medium tracking-wide uppercase">
              E-mail
            </dt>
            <dd className="mt-0.5 text-sm break-all">{user.email}</dd>
          </div>
          <div>
            <dt className="text-muted text-xs font-medium tracking-wide uppercase">
              Conta criada
            </dt>
            <dd className="mt-0.5 text-sm">
              {new Date(user.created_at).toLocaleDateString('pt-BR')}
            </dd>
          </div>
          <div>
            <dt className="text-muted text-xs font-medium tracking-wide uppercase">
              Provedor
            </dt>
            <dd className="mt-0.5 text-sm capitalize">
              {user.app_metadata?.provider ?? '—'}
            </dd>
          </div>
        </dl>
      </Card>

      <Card className="space-y-3">
        <div className="flex items-center gap-2">
          <Database className="text-ink h-4 w-4" />
          <h2 className="font-semibold">Integrações</h2>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {links.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="group bg-surface hover:border-primary/40 hover:bg-sunken rounded-[var(--radius-inner)] p-4 transition-colors"
            >
              <div className="flex items-start gap-3">
                <link.icon className="text-muted mt-0.5 h-4 w-4 shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{link.title}</p>
                  <p className="text-muted mt-0.5 text-xs">
                    {link.description}
                  </p>
                </div>
                <ArrowRight className="text-muted h-4 w-4 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
              </div>
            </Link>
          ))}
        </div>
      </Card>

      <Card className="border-down bg-down/30 space-y-3 rounded-[var(--radius-inner)] border p-5">
        <h2 className="text-down-ink font-semibold">Encerrar sessão</h2>
        <p className="text-muted text-sm">
          Sai apenas deste navegador. Os tokens de MCP continuam válidos —
          revogue-os em{' '}
          <Link href="/mcps" className="underline underline-offset-2">
            Integração MCP
          </Link>{' '}
          se quiser cortar o acesso dos agentes.
        </p>
        <form action="/auth/logout" method="POST">
          <button
            type="submit"
            className="border-down bg-surface text-down-ink inline-flex h-9 items-center rounded-[var(--radius-control)] border px-4 text-sm font-medium transition-colors hover:bg-red-500/10"
          >
            Sair
          </button>
        </form>
      </Card>
    </div>
  )
}
