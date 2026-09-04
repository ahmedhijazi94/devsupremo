'use client'

import { useRouter } from 'next/navigation'
import { useTransition } from 'react'
import { activateProject } from '@/actions/projects'
import { toast } from 'sonner'
import { Zap } from 'lucide-react'

interface ActivateProjectButtonProps {
  projectId: string
  isActive: boolean
}

export function ActivateProjectButton({
  projectId,
  isActive,
}: ActivateProjectButtonProps) {
  const [isPending, startTransition] = useTransition()
  const router = useRouter()

  function handleActivate() {
    if (isActive) return

    startTransition(async () => {
      const result = await activateProject(projectId)
      if (result.error) {
        toast.error(result.error)
        return
      }
      toast.success('Projeto ativado! O agente já sabe o contexto.')
      router.refresh()
    })
  }

  if (isActive) {
    return (
      <button
        disabled
        className="bg-up text-up-ink inline-flex flex-1 cursor-default items-center justify-center gap-1.5 rounded-[var(--radius-control)] px-3 py-1.5 text-xs font-medium"
      >
        <Zap className="h-3 w-3" />
        Ativo
      </button>
    )
  }

  return (
    <button
      onClick={handleActivate}
      disabled={isPending}
      className="bg-sunken hover:bg-accent/10 inline-flex flex-1 items-center justify-center gap-1.5 rounded-[var(--radius-control)] px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50"
    >
      <Zap className="h-3 w-3" />
      {isPending ? 'Ativando...' : 'Ativar'}
    </button>
  )
}
