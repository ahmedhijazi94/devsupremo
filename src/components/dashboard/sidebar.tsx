import Link from 'next/link'
import { redirect } from 'next/navigation'
import type { User } from '@supabase/supabase-js'
import {
  LayoutDashboard,
  FolderOpen,
  Settings,
  GitBranch,
  Cpu,
  Zap,
} from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { cn } from '@/lib/utils'
import { ActiveProjectBadge } from './active-project-badge'

interface SidebarProps {
  user: User
}

const navItems = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/projects', label: 'Projetos', icon: FolderOpen },
  { href: '/accounts', label: 'Contas', icon: GitBranch },
  { href: '/mcps', label: 'MCPs', icon: Cpu },
  { href: '/settings', label: 'Configurações', icon: Settings },
]

export async function DashboardSidebar({ user }: SidebarProps) {
  const supabase = await createClient()

  const { data: activeProject } = await supabase
    .from('projects')
    .select('id, name, active_mcp, status')
    .eq('user_id', user.id)
    .eq('is_active', true)
    .single()

  return (
    <aside className="w-64 border-r bg-card flex flex-col shrink-0">
      {/* Logo */}
      <div className="p-5 border-b">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center">
            <Zap className="w-4 h-4 text-primary" />
          </div>
          <span className="font-bold text-lg">Supremo</span>
        </div>
      </div>

      {/* Active Project */}
      <div className="p-3 border-b">
        <ActiveProjectBadge project={activeProject} />
      </div>

      {/* Navigation */}
      <nav className="flex-1 p-3 space-y-1">
        {navItems.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
              'text-muted-foreground hover:text-foreground hover:bg-accent'
            )}
          >
            <item.icon className="w-4 h-4" />
            {item.label}
          </Link>
        ))}
      </nav>

      {/* User */}
      <div className="p-3 border-t">
        <div className="flex items-center gap-3 rounded-lg px-3 py-2">
          {user.user_metadata?.avatar_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={user.user_metadata.avatar_url}
              alt={user.user_metadata?.name ?? 'Avatar'}
              className="w-7 h-7 rounded-full"
            />
          ) : (
            <div className="w-7 h-7 rounded-full bg-primary/20 flex items-center justify-center text-xs font-bold">
              {(user.user_metadata?.name ?? user.email ?? '?')[0].toUpperCase()}
            </div>
          )}
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium truncate">
              {user.user_metadata?.name ?? user.email}
            </p>
            <p className="text-xs text-muted-foreground truncate">
              {user.email}
            </p>
          </div>
        </div>
      </div>
    </aside>
  )
}
