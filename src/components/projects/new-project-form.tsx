'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2 } from 'lucide-react'
import { createEmptyProject } from '@/actions/projects'
import { toast } from 'sonner'

export function NewProjectForm() {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [form, setForm] = useState({
    name: '',
    description: '',
  })

  const [nameError, setNameError] = useState('')

  function handleNameChange(e: React.ChangeEvent<HTMLInputElement>) {
    const val = e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '')
    setForm(prev => ({ ...prev, name: val }))
    setNameError('')
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()

    if (!form.name || form.name.length < 2) {
      setNameError('O nome deve ter no mínimo 2 caracteres.')
      return
    }

    startTransition(async () => {
      const { data, error } = await createEmptyProject(form.name, form.description)
      
      if (error) {
        toast.error(error)
      } else if (data) {
        toast.success('Projeto criado!')
        router.push(`/projects/${data.id}`)
      }
    })
  }

  if (isPending) {
    return (
      <div className="rounded-xl border p-10 text-center space-y-4">
        <Loader2 className="w-10 h-10 mx-auto animate-spin text-primary" />
        <p className="font-semibold text-lg">Criando projeto...</p>
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6 rounded-xl border bg-card p-6">
      {/* Nome do projeto */}
      <div className="space-y-2">
        <label className="text-sm font-medium">
          Nome do projeto <span className="text-destructive">*</span>
        </label>
        <input
          type="text"
          value={form.name}
          onChange={handleNameChange}
          placeholder="meu-app"
          required
          className="w-full rounded-lg border bg-background px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary"
        />
        {nameError && <p className="text-xs text-destructive">{nameError}</p>}
      </div>

      {/* Descrição */}
      <div className="space-y-2">
        <label className="text-sm font-medium">Descrição (opcional)</label>
        <input
          type="text"
          value={form.description}
          onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
          placeholder="O que esse app vai fazer?"
          maxLength={200}
          className="w-full rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
        />
      </div>

      <button
        type="submit"
        disabled={!form.name || !!nameError || isPending}
        className="w-full rounded-lg bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
      >
        Avançar para Configuração
      </button>
    </form>
  )
}
