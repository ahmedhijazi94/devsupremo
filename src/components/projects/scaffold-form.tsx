'use client'

import { useTransition } from 'react'
import { toast } from 'sonner'
import { scaffoldProject } from '@/actions/scaffold'
import { ScaffoldButton } from './scaffold-button'

interface ScaffoldFormProps {
  projectId: string
  disabled: boolean
}

export function ScaffoldForm({ projectId, disabled }: ScaffoldFormProps) {
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

          if (result.warnings && result.warnings.length > 0) {
            toast.warning('Provisionado, com ressalvas', {
              description: result.warnings.join(' '),
              duration: 20_000,
            })
            return
          }

          toast.success('Projeto provisionado', {
            description:
              'Repositório, banco, gates e baseline prontos. O CI já está rodando.',
          })
        })
      }}
    >
      <ScaffoldButton disabled={disabled || isPending} />
    </form>
  )
}
