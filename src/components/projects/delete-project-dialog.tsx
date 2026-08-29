'use client'

import { useState, useTransition } from 'react'
import { Trash2, AlertTriangle } from 'lucide-react'
import { toast } from 'sonner'
import { deleteProject } from '@/actions/projects'

interface DeleteProjectDialogProps {
  projectId: string
  projectName: string
}

export function DeleteProjectDialog({ projectId, projectName }: DeleteProjectDialogProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [isPending, startTransition] = useTransition()
  const [confirmName, setConfirmName] = useState('')

  function handleDelete(e: React.FormEvent) {
    e.preventDefault()
    if (confirmName !== projectName) return

    startTransition(async () => {
      try {
        const { error } = await deleteProject(projectId)
        if (error) {
          toast.error(error)
        } else {
          toast.success('Projeto excluído com sucesso.')
          setIsOpen(false)
        }
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
        className="p-1.5 rounded-lg border hover:bg-destructive/10 border-destructive/20 text-destructive transition-colors ml-2"
        title="Excluir Projeto"
      >
        <Trash2 className="w-3.5 h-3.5" />
      </button>
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
      <div className="w-full max-w-md p-6 bg-card border rounded-xl shadow-lg relative">
        <div className="flex items-center gap-3 text-destructive mb-4">
          <div className="p-2 bg-destructive/10 rounded-full">
            <AlertTriangle className="w-6 h-6" />
          </div>
          <h2 className="text-xl font-bold">DANGER ZONE</h2>
        </div>
        
        <p className="text-muted-foreground text-sm mb-4">
          Você está prestes a excluir o projeto <strong>{projectName}</strong>. 
          Isso irá deletar de forma <strong className="text-destructive">IRREVERSÍVEL</strong>:
        </p>
        <ul className="list-disc pl-5 text-sm text-muted-foreground mb-6 space-y-1">
          <li>O repositório no GitHub (e todo o código).</li>
          <li>O projeto no Supabase (banco de dados, storage, logs).</li>
          <li>Este projeto no dashboard do Supremo.</li>
        </ul>

        <form onSubmit={handleDelete} className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1">
              Digite <strong>{projectName}</strong> para confirmar:
            </label>
            <input
              type="text"
              value={confirmName}
              onChange={(e) => setConfirmName(e.target.value)}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-destructive"
              placeholder={projectName}
              required
            />
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={() => setIsOpen(false)}
              className="px-4 py-2 text-sm font-medium hover:bg-accent rounded-md transition-colors"
              disabled={isPending}
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={isPending || confirmName !== projectName}
              className="px-4 py-2 text-sm font-medium bg-destructive text-destructive-foreground rounded-md hover:bg-destructive/90 transition-colors disabled:opacity-50"
            >
              {isPending ? 'Excluindo...' : 'Sim, excluir tudo'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
