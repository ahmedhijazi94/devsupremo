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

  // Generate slug dynamically
  const slug = form.name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')

  function handleNameChange(e: React.ChangeEvent<HTMLInputElement>) {
    setForm(prev => ({ ...prev, name: e.target.value }))
    setNameError('')
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()

    if (!form.name || form.name.trim().length < 2) {
      setNameError('O nome deve ter no mínimo 2 caracteres.')
      return
    }

    startTransition(async () => {
      // Create project using the slug as the internal name for repo/supabase consistency, or store both
      const { data, error } = await createEmptyProject(slug, form.description)
      
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
      <div className="rounded-xl border border-line p-10 text-center space-y-4">
        <Loader2 className="w-10 h-10 mx-auto animate-spin text-ink" />
        <p className="font-semibold text-lg">Criando projeto...</p>
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6 rounded-xl border border-line bg-surface p-6">
      {/* Nome do projeto */}
      <div className="space-y-2">
        <label className="text-sm font-medium">
          Nome do projeto <span className="text-destructive">*</span>
        </label>
        <input
          type="text"
          value={form.name}
          onChange={handleNameChange}
          placeholder="Meu Novo Projeto"
          required
          className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
        />
        {nameError && <p className="text-xs text-destructive">{nameError}</p>}
        {slug && (
          <p className="text-xs text-muted mt-1">
            Repositório será: <span className="font-mono text-ink">{slug}</span>
          </p>
        )}
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
          className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
        />
      </div>

      <button
        type="submit"
        disabled={!form.name || !!nameError || isPending}
        className="w-full rounded-lg bg-accent px-4 py-3 text-sm font-semibold text-accent-ink hover:bg-accent/90 transition-colors disabled:opacity-50"
      >
        Avançar para Configuração
      </button>
    </form>
  )
}
