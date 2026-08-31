'use client'

import { useState } from 'react'
import { Monitor, Database, FlaskConical, Zap } from 'lucide-react'
import { PreviewPanel } from '@/components/projects/preview-panel'
import { DatabasePanel } from '@/components/projects/database-panel'
import { TestsPanel } from '@/components/projects/tests-panel'
import { cn } from '@/lib/utils'

type Tab = 'preview' | 'banco' | 'testes'

const TABS: { id: Tab; label: string; icon: typeof Monitor }[] = [
  { id: 'preview', label: 'Preview', icon: Monitor },
  { id: 'banco', label: 'Banco', icon: Database },
  { id: 'testes', label: 'Testes', icon: FlaskConical },
]

/**
 * O painel principal do projeto, com abas — a experiência de plataforma.
 *
 * Preview: a aplicação rodando. Banco: tabelas, RLS, Edge Functions. Testes:
 * os gates ao vivo. Tudo dentro do Supremo, sem sair para GitHub ou Supabase.
 */
export function WorkspaceTabs({
  projectId,
  repoFullName,
  provisioned,
}: {
  projectId: string
  repoFullName: string | null
  provisioned: boolean
}) {
  const [tab, setTab] = useState<Tab>('preview')

  if (!provisioned) {
    return (
      <div className="bg-sunken flex h-full items-center justify-center rounded-[var(--radius-inner)]">
        <div className="max-w-sm px-6 text-center">
          <Zap className="text-muted mx-auto mb-3 h-6 w-6" />
          <p className="text-sm font-medium">Nada publicado ainda</p>
          <p className="text-muted mt-1.5 text-sm">
            Provisione a infraestrutura ao lado. Depois disso o app, o banco e
            os testes aparecem aqui.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex gap-1.5">
        {TABS.map((t) => {
          const on = t.id === tab
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              aria-pressed={on}
              className={cn(
                'inline-flex items-center gap-2 rounded-[var(--radius-control)] px-3 py-1.5 text-sm font-medium transition-colors',
                on
                  ? 'bg-accent text-accent-ink'
                  : 'bg-surface text-muted hover:text-ink',
              )}
            >
              <t.icon className="h-4 w-4" />
              {t.label}
            </button>
          )
        })}
      </div>

      <div className="min-h-0 flex-1">
        {/* Todos montados, só um visível: preserva o preview carregado ao
            trocar de aba, e evita refazer a consulta do banco/testes à toa. */}
        <div className={cn('h-full', tab !== 'preview' && 'hidden')}>
          <PreviewPanel repoFullName={repoFullName} projectId={projectId} />
        </div>
        {tab === 'banco' && (
          <div className="h-full">
            <DatabasePanel projectId={projectId} />
          </div>
        )}
        {tab === 'testes' && (
          <div className="h-full">
            <TestsPanel projectId={projectId} />
          </div>
        )}
      </div>
    </div>
  )
}
