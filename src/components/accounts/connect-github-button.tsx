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
      className="inline-flex items-center gap-2 rounded-lg bg-secondary px-3 py-1.5 text-sm font-medium hover:bg-secondary/80 transition-colors disabled:opacity-50"
    >
      <GitBranch className="w-4 h-4" />
      {isPending ? 'Redirecionando...' : 'Conectar GitHub'}
    </button>
  )
}
