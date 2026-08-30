'use client'

import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'
import { LogOut } from 'lucide-react'
import { toast } from 'sonner'

export function SignOutButton() {
  const router = useRouter()
  const supabase = createClient()

  async function handleSignOut() {
    const { error } = await supabase.auth.signOut()
    if (error) {
      toast.error('Erro ao sair. Tente novamente.')
      return
    }
    router.push('/login')
    router.refresh()
  }

  return (
    <button
      onClick={handleSignOut}
      className="hover:bg-sunken text-muted hover:text-ink rounded-[var(--radius-control)] p-2 transition-colors"
      title="Sair"
    >
      <LogOut className="h-4 w-4" />
    </button>
  )
}
