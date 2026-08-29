import type { User } from '@supabase/supabase-js'
import { Bell, Moon } from 'lucide-react'
import { SignOutButton } from '@/components/auth/sign-out-button'

interface DashboardHeaderProps {
  user: User
}

export function DashboardHeader({ user }: DashboardHeaderProps) {
  return (
    <header className="h-14 border-b bg-card/50 backdrop-blur-sm flex items-center justify-between px-6 shrink-0">
      <div />
      <div className="flex items-center gap-2">
        <button className="p-2 rounded-lg hover:bg-accent transition-colors text-muted-foreground hover:text-foreground">
          <Bell className="w-4 h-4" />
        </button>
        <SignOutButton />
      </div>
    </header>
  )
}
