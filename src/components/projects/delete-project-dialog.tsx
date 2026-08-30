'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Trash2, AlertTriangle } from 'lucide-react'
import { toast } from 'sonner'
import { deleteProject } from '@/actions/projects'

interface DeleteProjectDialogProps {
  projectId: string
  projectName: string
}

export function DeleteProjectDialog({
  projectId,
  projectName,
}: DeleteProjectDialogProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [isPending, startTransition] = useTransition()
  const [confirmName, setConfirmName] = useState('')
  const router = useRouter()

  function handleDelete(e: React.FormEvent) {
    e.preventDefault()
    if (confirmName !== projectName) return

    startTransition(async () => {
      try {
        const result = await deleteProject(projectId)

        if (result.error) {
          toast.error(result.error)
          return
        }

        // Sobra externa não impede a exclusão, mas o usuário precisa saber
        // o que ficou para trás para limpar à mão.
        if (result.warnings && result.warnings.length > 0) {
          toast.warning('Projeto excluído, com sobras', {
            description: result.warnings.join(' '),
            duration: 20_000,
          })
        } else {
          toast.success('Projeto excluído.')
        }

        setIsOpen(false)
        router.push('/dashboard')
        router.refresh()
      } catch (err) {
        toast.error('Erro ao excluir projeto.')
      }
    })
  }

  if (!isOpen) {
    return (
      <button
        onClick={(e) => {
          e.preventDefault()
          setIsOpen(true)
        }}
        className="hover:bg-destructive/10 border-destructive/20 text-destructive ml-2 rounded-[var(--radius-control)] p-1.5 transition-colors"
        title="Excluir Projeto"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    )
  }

  return (
    <div className="bg-surface/80 fixed inset-0 z-50 flex items-center justify-center backdrop-blur-sm">
      <div className="bg-surface relative w-full max-w-md rounded-[var(--radius-inner)] p-6 shadow-lg">
        <div className="text-destructive mb-4 flex items-center gap-3">
          <div className="bg-destructive/10 rounded-full p-2">
            <AlertTriangle className="h-6 w-6" />
          </div>
          <h2 className="text-xl font-bold">DANGER ZONE</h2>
        </div>

        <p className="text-muted mb-4 text-sm">
          Você está prestes a excluir o projeto <strong>{projectName}</strong>.
          Isso irá deletar de forma{' '}
          <strong className="text-destructive">IRREVERSÍVEL</strong>:
        </p>
        <ul className="text-muted mb-6 list-disc space-y-1 pl-5 text-sm">
          <li>O repositório no GitHub (e todo o código).</li>
          <li>O projeto no Supabase (banco de dados, storage, logs).</li>
          <li>Este projeto no dashboard do Supremo.</li>
        </ul>

        <form onSubmit={handleDelete} className="space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium">
              Digite <strong>{projectName}</strong> para confirmar:
            </label>
            <input
              type="text"
              value={confirmName}
              onChange={(e) => setConfirmName(e.target.value)}
              className="bg-surface placeholder:text-muted focus:ring-destructive w-full rounded-md px-3 py-2 text-sm focus:ring-2 focus:outline-none"
              placeholder={projectName}
              required
            />
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={() => setIsOpen(false)}
              className="hover:bg-sunken rounded-md px-4 py-2 text-sm font-medium transition-colors"
              disabled={isPending}
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={isPending || confirmName !== projectName}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90 rounded-md px-4 py-2 text-sm font-medium transition-colors disabled:opacity-50"
            >
              {isPending ? 'Excluindo...' : 'Sim, excluir tudo'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
