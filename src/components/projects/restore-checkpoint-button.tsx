'use client'

import { useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { History } from 'lucide-react'
import { toast } from 'sonner'
import { requestCheckpointRestore } from '@/actions/checkpoints'

interface RestoreCheckpointButtonProps {
  projectId: string
  checkpointId: string
  summary: string
}

/**
 * "Restaurar este ponto" — NUNCA reseta nada aqui: só cria o PEDIDO. O daemon
 * da máquina original aplica localmente e fecha com um checkpoint novo. O
 * histórico continua inteiro (A→B→C→D→E), nunca reescrito.
 */
export function RestoreCheckpointButton({
  projectId,
  checkpointId,
  summary,
}: RestoreCheckpointButtonProps) {
  const [isPending, startTransition] = useTransition()
  const router = useRouter()

  function handleClick() {
    if (
      !window.confirm(
        `Restaurar "${summary}"?\n\nSeu workspace local volta a este ponto (o trabalho ` +
          'atual é salvo automaticamente antes, se houver algo não salvo). O histórico ' +
          'continua inteiro — isto cria um novo ponto, não apaga nada.',
      )
    ) {
      return
    }
    startTransition(async () => {
      const result = await requestCheckpointRestore(projectId, checkpointId)
      if (result.error) {
        toast.error(result.error)
        return
      }
      toast.success('Restauração pedida — aplicando na máquina que criou este ponto…')
      router.refresh()
    })
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={isPending}
      className="border-line text-ink-soft hover:border-line-strong hover:text-ink inline-flex items-center gap-1.5 rounded-[var(--radius-control)] border px-2.5 py-1 text-xs font-medium transition disabled:opacity-50"
    >
      <History className="size-3.5" />
      {isPending ? 'Restaurando…' : 'Restaurar'}
    </button>
  )
}
