import Link from 'next/link'
import { redirect } from 'next/navigation'
import type { User } from '@supabase/supabase-js'
import {
  LayoutDashboard,
  FolderOpen,
  Settings,
  Cpu,
  Zap,
  LogOut,
  ChevronRight,
} from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { cn } from '@/lib/utils'
import { ActiveProjectBadge } from './active-project-badge'
import { headers } from 'next/headers'

interface SidebarProps {
  user: User
}

const navItems = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/projects', label: 'Projetos', icon: FolderOpen },
  { href: '/mcps', label: 'Integração MCP', icon: Cpu },
  { href: '/settings', label: 'Configurações', icon: Settings },
]

export async function DashboardSidebar({ user }: SidebarProps) {
  const supabase = await createClient()
  const headersList = await headers()
  const pathname = headersList.get('x-pathname') || ''

  const { data: activeProject } = await supabase
    .from('projects')
    .select('id, name, active_mcp, status')
    .eq('user_id', user.id)
    .eq('is_active', true)
    .single()

  return (
    <aside className="w-60 border-r bg-card flex flex-col shrink-0 h-screen sticky top-0">
      {/* Logo */}
      <div className="px-4 py-5 border-b">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-violet-500 to-blue-600 flex items-center justify-center shadow-sm">
            <Zap className="w-4 h-4 text-white" />
          </div>
          <div>
            <span className="font-bold text-sm tracking-tight">Supremo</span>
            <span className="ml-1.5 text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-violet-500/10 text-violet-600 border border-violet-500/20">
              v1.0
            </span>
          </div>
        </div>
      </div>

      {/* Active Project */}
      <div className="px-3 py-2.5 border-b bg-muted/30">
        <ActiveProjectBadge project={activeProject} />
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-2 py-3 space-y-0.5">
        {navItems.map((item) => {
          const isActive = pathname === item.href || pathname.startsWith(item.href + '/')
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-all group',
                isActive
                  ? 'bg-primary text-primary-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground hover:bg-accent'
              )}
            >
              <item.icon className="w-4 h-4 shrink-0" />
              <span className="flex-1">{item.label}</span>
              {isActive && <ChevronRight className="w-3.5 h-3.5 opacity-60" />}
            </Link>
          )
        })}
      </nav>

      {/* User */}
      <div className="p-3 border-t">
        <div className="flex items-center gap-3 rounded-lg px-3 py-2 group">
          {user.user_metadata?.avatar_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={user.user_metadata.avatar_url}
              alt={user.user_metadata?.name ?? 'Avatar'}
              className="w-7 h-7 rounded-full ring-1 ring-border"
            />
          ) : (
            <div className="w-7 h-7 rounded-full bg-gradient-to-br from-violet-500 to-blue-600 flex items-center justify-center text-xs font-bold text-white">
              {(user.user_metadata?.name ?? user.email ?? '?')[0].toUpperCase()}
            </div>
          )}
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium truncate">
              {user.user_metadata?.name ?? user.email}
            </p>
            <p className="text-[11px] text-muted-foreground truncate">
              {user.email}
            </p>
          </div>
          <form action="/auth/logout" method="POST">
            <button
              type="submit"
              className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
              title="Sair"
            >
              <LogOut className="w-3.5 h-3.5" />
            </button>
          </form>
        </div>
      </div>
    </aside>
  )
}
