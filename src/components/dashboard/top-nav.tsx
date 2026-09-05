import Link from 'next/link'
import { headers } from 'next/headers'
import type { User } from '@supabase/supabase-js'
import {
  LayoutDashboard,
  FolderOpen,
  Link2,
  Settings,
  LogOut,
  Zap,
} from 'lucide-react'
import { cn } from '@/lib/utils'

// Navegação do fluxo local: bootstrap, checkpoints e acompanhamento.

const NAV = [
  { href: '/dashboard', label: 'Painel', icon: LayoutDashboard },
  { href: '/projects', label: 'Projetos', icon: FolderOpen },
  { href: '/accounts', label: 'Contas', icon: Link2 },
  { href: '/settings', label: 'Ajustes', icon: Settings },
] as const

/**
 * Navegação principal.
 *
 * Horizontal e no topo: a largura da tela vale mais para o conteúdo do que
 * para uma coluna de links que fica parada. A marca ancora à esquerda, os
 * destinos ao centro, a identidade à direita — a ordem que o olho percorre.
 */
export async function TopNav({ user }: { user: User }) {
  const headersList = await headers()
  const pathname = headersList.get('x-pathname') ?? ''

  const name =
    (user.user_metadata?.name as string | undefined) ??
    user.email?.split('@')[0] ??
    'Conta'
  const avatar = user.user_metadata?.avatar_url as string | undefined

  return (
    <nav className="bg-surface flex h-16 shrink-0 items-center gap-6 rounded-[var(--radius-card)] px-5">
      <Link href="/dashboard" className="flex shrink-0 items-center gap-2.5">
        <span className="bg-accent flex h-8 w-8 items-center justify-center rounded-[var(--radius-control)]">
          <Zap className="text-accent-ink h-4 w-4" />
        </span>
        <span className="text-lg font-semibold tracking-tight">Supremo</span>
      </Link>

      <ul className="hidden min-w-0 flex-1 items-center justify-center gap-1 md:flex">
        {NAV.map((item) => {
          const active =
            pathname === item.href || pathname.startsWith(`${item.href}/`)

          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'relative flex items-center gap-2 rounded-[var(--radius-control)] px-3 py-2 text-sm font-medium transition-colors',
                  active
                    ? 'text-ink'
                    : 'text-muted hover:bg-sunken hover:text-ink',
                )}
              >
                <item.icon className="h-4 w-4" />
                {item.label}
                {active && (
                  <span
                    aria-hidden
                    className="bg-accent absolute inset-x-3 -bottom-[13px] h-0.5 rounded-full"
                  />
                )}
              </Link>
            </li>
          )
        })}
      </ul>

      <div className="ml-auto flex shrink-0 items-center gap-2 md:ml-0">
        <div className="bg-sunken flex items-center gap-2.5 rounded-full py-1 pr-3 pl-1">
          {avatar ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={avatar}
              alt=""
              className="h-7 w-7 rounded-full object-cover"
            />
          ) : (
            <span className="bg-accent text-accent-ink flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold">
              {name[0]?.toUpperCase()}
            </span>
          )}
          <span className="hidden max-w-[10rem] truncate text-sm font-medium sm:block">
            {name}
          </span>
        </div>

        <form action="/auth/logout" method="POST">
          <button
            type="submit"
            title="Sair"
            className="text-muted hover:bg-sunken hover:text-ink flex h-9 w-9 items-center justify-center rounded-full transition-colors"
          >
            <LogOut className="h-4 w-4" />
          </button>
        </form>
      </div>
    </nav>
  )
}

/** Navegação em telas estreitas: os mesmos destinos, empilhados embaixo. */
export async function MobileNav() {
  const headersList = await headers()
  const pathname = headersList.get('x-pathname') ?? ''

  return (
    <nav className="bg-surface flex items-center gap-1 overflow-x-auto rounded-[var(--radius-card)] px-2 py-2 md:hidden">
      {NAV.map((item) => {
        const active =
          pathname === item.href || pathname.startsWith(`${item.href}/`)

        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex shrink-0 items-center gap-1.5 rounded-[var(--radius-control)] px-3 py-2 text-sm font-medium transition-colors',
              active ? 'bg-accent text-accent-ink' : 'text-muted',
            )}
          >
            <item.icon className="h-4 w-4" />
            {item.label}
          </Link>
        )
      })}
    </nav>
  )
}
