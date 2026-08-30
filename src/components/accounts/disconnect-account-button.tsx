'use client'

import { useTransition } from 'react'
import { Trash2 } from 'lucide-react'
import {
  disconnectGithubAccount,
  disconnectSupabaseAccount,
} from '@/actions/accounts'
import { toast } from 'sonner'

interface DisconnectAccountButtonProps {
  type: 'github' | 'supabase'
  accountId: string
}

export function DisconnectAccountButton({
  type,
  accountId,
}: DisconnectAccountButtonProps) {
  const [isPending, startTransition] = useTransition()

  function handleDisconnect() {
    if (
      !confirm(
        'Tem certeza? Projetos que usam essa conta podem parar de funcionar.',
      )
    )
      return

    startTransition(async () => {
      const action =
        type === 'github' ? disconnectGithubAccount : disconnectSupabaseAccount
      const result = await action(accountId)
      if (result.error) {
        toast.error(result.error)
        return
      }
      toast.success('Conta desconectada.')
    })
  }

  return (
    <button
      onClick={handleDisconnect}
      disabled={isPending}
      className="text-muted hover:bg-down hover:text-down-ink rounded-[var(--radius-control)] p-2 transition-colors disabled:opacity-50"
      title="Desconectar conta"
    >
      <Trash2 className="h-4 w-4" />
    </button>
  )
}
