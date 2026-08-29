'use client'

import { useTransition } from 'react'
import { scaffoldProject } from '@/actions/scaffold'
import { toast } from 'sonner'
import { ScaffoldButton } from './scaffold-button'

export function ScaffoldForm({ projectId, disabled }: { projectId: string, disabled: boolean }) {
  const [isPending, startTransition] = useTransition()

  return (
    <form action={() => {
      startTransition(async () => {
        const res = await scaffoldProject(projectId)
        if (res.error) {
          console.error('SCAFFOLD ERROR:', res.error)
          toast.error(res.error)
        } else {
          toast.success('Infraestrutura provisionada com sucesso!')
        }
      })
    }}>
      <ScaffoldButton disabled={disabled || isPending} />
    </form>
  )
}
