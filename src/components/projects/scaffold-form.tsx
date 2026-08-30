'use client'

import { useTransition } from 'react'
import { scaffoldProject } from '@/actions/scaffold'
import { toast } from 'sonner'
import { ScaffoldButton } from './scaffold-button'

export function ScaffoldForm({
  projectId,
  disabled,
}: {
  projectId: string
  disabled: boolean
}) {
  const [isPending, startTransition] = useTransition()

  return (
    <form
      action={() => {
        startTransition(async () => {
          const result = await scaffoldProject(projectId)

          if (result.error) {
            toast.error(result.error, { duration: 10_000 })
            return
          }

          // Provisionamento parcial não é sucesso silencioso: coisas como a
          // proteção de branch podem falhar por limite do plano do GitHub, e
          // o usuário precisa saber que o gate ficou contornável.
          if (result.warnings && result.warnings.length > 0) {
            toast.warning('Provisionado, com ressalvas', {
              description: result.warnings.join(' '),
              duration: 20_000,
            })
            return
          }

          toast.success('Projeto provisionado', {
            description:
              'Repositório, banco e gates prontos. O CI já está rodando.',
          })
        })
      }}
    >
      <ScaffoldButton disabled={disabled || isPending} />
    </form>
  )
}
