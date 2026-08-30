import { redirect } from 'next/navigation'
import Link from 'next/link'
import { Settings, User, KeyRound, GitBranch, Database, ArrowRight } from 'lucide-react'
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

  const [{ count: githubCount }, { count: supabaseCount }, { count: tokenCount }] =
    await Promise.all([
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
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Settings className="w-6 h-6 text-ink" />
          Configurações
        </h1>
        <p className="text-muted mt-1.5">
          Sua conta, integrações e acessos.
        </p>
      </Card>

      <Card className="space-y-4">
        <div className="flex items-center gap-2">
          <User className="w-4 h-4 text-ink" />
          <h2 className="font-semibold">Perfil</h2>
        </div>
        <dl className="grid gap-3 sm:grid-cols-2">
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-muted">
              Nome
            </dt>
            <dd className="text-sm mt-0.5">
              {(user.user_metadata?.name as string | undefined) ?? '—'}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-muted">
              E-mail
            </dt>
            <dd className="text-sm mt-0.5 break-all">{user.email}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-muted">
              Conta criada
            </dt>
            <dd className="text-sm mt-0.5">
              {new Date(user.created_at).toLocaleDateString('pt-BR')}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-muted">
              Provedor
            </dt>
            <dd className="text-sm mt-0.5 capitalize">
              {user.app_metadata?.provider ?? '—'}
            </dd>
          </div>
        </dl>
      </Card>

      <Card className="space-y-3">
        <div className="flex items-center gap-2">
          <Database className="w-4 h-4 text-ink" />
          <h2 className="font-semibold">Integrações</h2>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {links.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="group rounded-xl border border-line bg-surface p-4 hover:border-primary/40 hover:bg-sunken transition-colors"
            >
              <div className="flex items-start gap-3">
                <link.icon className="w-4 h-4 text-muted mt-0.5 shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">{link.title}</p>
                  <p className="text-xs text-muted mt-0.5">
                    {link.description}
                  </p>
                </div>
                <ArrowRight className="w-4 h-4 text-muted opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
              </div>
            </Link>
          ))}
        </div>
      </Card>

      <Card className="rounded-xl border border-down bg-down/30 p-5 space-y-3">
        <h2 className="font-semibold text-down-ink">
          Encerrar sessão
        </h2>
        <p className="text-sm text-muted">
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
            className="h-9 inline-flex items-center rounded-lg border border-down bg-surface px-4 text-sm font-medium text-down-ink hover:bg-red-500/10 transition-colors"
          >
            Sair
          </button>
        </form>
      </Card>
    </div>
  )
}
