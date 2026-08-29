'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { scaffoldProject } from '@/actions/scaffold'
import { toast } from 'sonner'
import { Loader2, GitBranch, Database, Zap, CheckCircle } from 'lucide-react'

interface Account {
  id: string
  login?: string
  avatar_url?: string | null
  org_name?: string
  org_slug?: string
}

interface NewProjectFormProps {
  githubAccounts: Account[]
  supabaseAccounts: Account[]
}

const STEPS = [
  'Criando repositório GitHub...',
  'Gerando agents.md, CLAUDE.md, SECURITY.md...',
  'Fazendo commit inicial...',
  'Criando projeto Supabase...',
  'Aguardando provisionamento do banco (~90s)...',
  'Aplicando migrations iniciais...',
  'Salvando projeto...',
]

export function NewProjectForm({ githubAccounts, supabaseAccounts }: NewProjectFormProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [currentStep, setCurrentStep] = useState(0)
  const [done, setDone] = useState(false)

  const [form, setForm] = useState({
    name: '',
    description: '',
    githubAccountId: githubAccounts[0]?.id ?? '',
    supabaseAccountId: supabaseAccounts[0]?.id ?? '',
    stack: 'nextjs' as const,
  })
  const [nameError, setNameError] = useState('')

  function validateName(value: string) {
    if (!/^[a-z0-9-]*$/.test(value)) {
      setNameError('Apenas letras minúsculas, números e hífens.')
    } else if (value.length > 0 && value.length < 2) {
      setNameError('Mínimo 2 caracteres.')
    } else {
      setNameError('')
    }
  }

  function handleNameChange(e: React.ChangeEvent<HTMLInputElement>) {
    const value = e.target.value.toLowerCase().replace(/\s+/g, '-')
    setForm(f => ({ ...f, name: value }))
    validateName(value)
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!form.name || nameError) return
    if (!form.githubAccountId) {
      toast.error('Conecte uma conta GitHub primeiro em /accounts')
      return
    }

    startTransition(async () => {
      // Simular steps visuais
      const interval = setInterval(() => {
        setCurrentStep(s => Math.min(s + 1, STEPS.length - 1))
      }, 1500)

      const result = await scaffoldProject({
        name: form.name,
        description: form.description || undefined,
        githubAccountId: form.githubAccountId,
        supabaseAccountId: form.supabaseAccountId || undefined,
        stack: form.stack,
      })

      clearInterval(interval)

      if (result.error) {
        toast.error(result.error)
        setCurrentStep(0)
        return
      }

      setDone(true)
      setTimeout(() => {
        router.push(`/dashboard`)
      }, 1500)
    })
  }

  if (githubAccounts.length === 0) {
    return (
      <div className="rounded-xl border border-dashed p-10 text-center space-y-3">
        <GitBranch className="w-10 h-10 mx-auto text-muted-foreground" />
        <p className="font-semibold">Nenhuma conta GitHub conectada</p>
        <p className="text-sm text-muted-foreground">
          Para criar projetos, conecte uma conta GitHub primeiro.
        </p>
        <a
          href="/accounts"
          className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          Conectar GitHub
        </a>
      </div>
    )
  }

  if (done) {
    return (
      <div className="rounded-xl border p-10 text-center space-y-3 bg-green-500/5 border-green-500/20">
        <CheckCircle className="w-12 h-12 mx-auto text-green-500" />
        <p className="font-semibold text-lg">Projeto criado com sucesso!</p>
        <p className="text-sm text-muted-foreground">Redirecionando para o dashboard...</p>
      </div>
    )
  }

  if (isPending) {
    return (
      <div className="rounded-xl border p-10 text-center space-y-6">
        <Loader2 className="w-12 h-12 mx-auto animate-spin text-primary" />
        <div className="space-y-2">
          <p className="font-semibold">Criando projeto...</p>
          <p className="text-sm text-muted-foreground">{STEPS[currentStep]}</p>
        </div>
        <div className="flex gap-1 justify-center">
          {STEPS.map((_, i) => (
            <div
              key={i}
              className={`h-1.5 w-12 rounded-full transition-colors ${
                i <= currentStep ? 'bg-primary' : 'bg-muted'
              }`}
            />
          ))}
        </div>
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6 rounded-xl border bg-card p-6">
      {/* Nome do projeto */}
      <div className="space-y-2">
        <label className="text-sm font-medium">
          Nome do projeto <span className="text-red-500">*</span>
        </label>
        <input
          type="text"
          value={form.name}
          onChange={handleNameChange}
          placeholder="meu-app"
          required
          className="w-full rounded-lg border bg-background px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary"
        />
        {nameError && <p className="text-xs text-red-500">{nameError}</p>}
        {form.name && !nameError && (
          <p className="text-xs text-muted-foreground">
            Repositório: <span className="font-mono text-foreground">github.com/…/{form.name}</span>
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
          className="w-full rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
        />
      </div>

      {/* Conta GitHub */}
      <div className="space-y-2">
        <label className="text-sm font-medium flex items-center gap-2">
          <GitBranch className="w-4 h-4" /> Conta GitHub
        </label>
        <select
          value={form.githubAccountId}
          onChange={e => setForm(f => ({ ...f, githubAccountId: e.target.value }))}
          className="w-full rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
        >
          {githubAccounts.map(acc => (
            <option key={acc.id} value={acc.id}>
              {acc.login}
            </option>
          ))}
        </select>
      </div>

      {/* Conta Supabase */}
      <div className="space-y-2">
        <label className="text-sm font-medium flex items-center gap-2">
          <Database className="w-4 h-4 text-[#3ECF8E]" /> Conta Supabase (opcional)
        </label>
        <select
          value={form.supabaseAccountId}
          onChange={e => setForm(f => ({ ...f, supabaseAccountId: e.target.value }))}
          className="w-full rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
        >
          <option value="">Nenhuma (adicionar depois)</option>
          {supabaseAccounts.map(acc => (
            <option key={acc.id} value={acc.id}>
              {acc.org_name}
            </option>
          ))}
        </select>
      </div>

      {/* O que será criado */}
      <div className="rounded-lg bg-primary/5 border border-primary/20 p-4 space-y-2">
        <p className="text-sm font-medium flex items-center gap-2">
          <Zap className="w-4 h-4 text-primary" />
          O Supremo vai criar automaticamente:
        </p>
        <ul className="text-xs text-muted-foreground space-y-1 ml-6 list-disc">
          <li>Repositório privado no GitHub</li>
          <li><code>agents.md</code> — contexto do projeto para MCPs</li>
          <li><code>CLAUDE.md</code> — regras de comportamento para IA</li>
          <li><code>SECURITY.md</code> — políticas de segurança</li>
          <li><code>.env.example</code> e <code>.gitignore</code></li>
          <li>Primeiro commit automático</li>
        </ul>
      </div>

      <button
        type="submit"
        disabled={!form.name || !!nameError || isPending}
        className="w-full rounded-lg bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
      >
        Criar Projeto
      </button>
    </form>
  )
}
