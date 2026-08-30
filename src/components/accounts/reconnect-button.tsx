'use client'

import { useTransition } from 'react'
import { RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { connectGithubAccount, connectSupabaseAccount } from '@/actions/accounts'

interface ReconnectButtonProps {
  provider: 'github' | 'supabase'
  label: string
}

/**
 * Renova a autorização de uma conta já conectada.
 *
 * O token guardado expira ou é revogado — quando isso acontece, tudo que
 * depende dele falha com mensagens que não dizem a causa. O caminho para
 * consertar existia (o mesmo botão de conectar sobrescreve a conta), mas
 * nada na tela indicava isso.
 */
export function ReconnectButton({ provider, label }: ReconnectButtonProps) {
  const [isPending, startTransition] = useTransition()

  return (
    <button
      onClick={() =>
        startTransition(async () => {
          try {
            if (provider === 'github') await connectGithubAccount()
            else await connectSupabaseAccount()
          } catch {
            toast.error('Não foi possível iniciar a reconexão.')
          }
        })
      }
      disabled={isPending}
      title={`Renovar a autorização de ${label}`}
      className="inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-xs font-medium text-muted transition-colors hover:text-ink disabled:opacity-50"
    >
      <RefreshCw className={`h-3.5 w-3.5 ${isPending ? 'animate-spin' : ''}`} />
      Reconectar
    </button>
  )
}
