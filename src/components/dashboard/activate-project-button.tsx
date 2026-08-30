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
      toast.success('Projeto ativado! O MCP já sabe o contexto.')
      router.refresh()
    })
  }

  if (isActive) {
    return (
      <button
        disabled
        className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg bg-green-500/10 border border-line border-green-500/20 px-3 py-1.5 text-xs font-medium text-green-600 cursor-default"
      >
        <Zap className="w-3 h-3" />
        Ativo
      </button>
    )
  }

  return (
    <button
      onClick={handleActivate}
      disabled={isPending}
      className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg bg-sunken border border-line px-3 py-1.5 text-xs font-medium hover:bg-accent/10 transition-colors disabled:opacity-50"
    >
      <Zap className="w-3 h-3" />
      {isPending ? 'Ativando...' : 'Ativar'}
    </button>
  )
}
