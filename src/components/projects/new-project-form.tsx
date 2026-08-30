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
  const slug = form.name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')

  function handleNameChange(e: React.ChangeEvent<HTMLInputElement>) {
    setForm((prev) => ({ ...prev, name: e.target.value }))
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
      <div className="space-y-4 rounded-[var(--radius-inner)] p-10 text-center">
        <Loader2 className="text-ink mx-auto h-10 w-10 animate-spin" />
        <p className="text-lg font-semibold">Criando projeto...</p>
      </div>
    )
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="bg-surface space-y-6 rounded-[var(--radius-card)] p-6"
    >
      {/* Nome do projeto */}
      <div className="space-y-2">
        <label className="text-sm font-medium">
          Nome do projeto <span className="text-down-ink">*</span>
        </label>
        <input
          type="text"
          value={form.name}
          onChange={handleNameChange}
          placeholder="Meu Novo Projeto"
          required
          className="bg-sunken focus:ring-ink w-full rounded-[var(--radius-control)] px-3 py-2 text-sm focus:ring-2 focus:outline-none"
        />
        {nameError && <p className="text-down-ink text-xs">{nameError}</p>}
        {slug && (
          <p className="text-muted mt-1 text-xs">
            Repositório será: <span className="text-ink font-mono">{slug}</span>
          </p>
        )}
      </div>

      {/* Descrição */}
      <div className="space-y-2">
        <label className="text-sm font-medium">Descrição (opcional)</label>
        <input
          type="text"
          value={form.description}
          onChange={(e) =>
            setForm((f) => ({ ...f, description: e.target.value }))
          }
          placeholder="O que esse app vai fazer?"
          maxLength={200}
          className="bg-sunken focus:ring-ink w-full rounded-[var(--radius-control)] px-3 py-2 text-sm focus:ring-2 focus:outline-none"
        />
      </div>

      <button
        type="submit"
        disabled={!form.name || !!nameError || isPending}
        className="bg-accent text-accent-ink hover:bg-accent/90 w-full rounded-[var(--radius-control)] px-4 py-3 text-sm font-semibold transition-colors disabled:opacity-50"
      >
        Avançar para Configuração
      </button>
    </form>
  )
}
