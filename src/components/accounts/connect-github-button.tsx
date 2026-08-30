'use client'

import { useTransition } from 'react'
import { GitBranch } from 'lucide-react'
import { connectGithubAccount } from '@/actions/accounts'
import { toast } from 'sonner'

export function ConnectGithubButton() {
  const [isPending, startTransition] = useTransition()

  function handleConnect() {
    startTransition(async () => {
      try {
        await connectGithubAccount()
      } catch {
        toast.error('Erro ao iniciar conexão com GitHub.')
      }
    })
  }

  return (
    <button
      onClick={handleConnect}
      disabled={isPending}
      className="bg-sunken hover:bg-sunken inline-flex items-center gap-2 rounded-[var(--radius-control)] px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-50"
    >
      <GitBranch className="h-4 w-4" />
      {isPending ? 'Redirecionando...' : 'Conectar GitHub'}
    </button>
  )
}
