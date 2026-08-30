'use client'

import { useTransition } from 'react'
import { Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { disconnectVercelAccount } from '@/actions/vercel'

export function DisconnectVercelButton({ accountId }: { accountId: string }) {
  const [isPending, startTransition] = useTransition()

  return (
    <button
      onClick={() =>
        startTransition(async () => {
          const result = await disconnectVercelAccount(accountId)
          if (result.error) {
            toast.error(result.error)
            return
          }
          toast.success('Conta Vercel desconectada', {
            description:
              'Os projetos existentes continuam publicados; novos deploys param.',
          })
        })
      }
      disabled={isPending}
      title="Desconectar"
      className="rounded-lg p-2 text-muted-foreground transition-colors hover:bg-red-500/10 hover:text-red-500 disabled:opacity-50"
    >
      <Trash2 className="h-4 w-4" />
    </button>
  )
}
