'use client'

import { useState } from 'react'
import { PanelsTopLeft, Activity } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * O corpo da página do projeto: painel lateral + workspace.
 *
 * No desktop, lado a lado. No celular vira duas abas — Atividade e App — porque
 * empilhar os dois numa coluna só dava uma rolagem sem fim, longe do que se
 * espera de um app mobile. Uma aba por vez, cada uma em tela cheia.
 *
 * O `min-w-0` na coluna do workspace é o que segura o código/preview dentro do
 * wrapper: sem ele, uma linha longa empurra o layout além da tela e os botões
 * escapam pela direita.
 */
type MobileTab = 'painel' | 'app'

export function WorkspaceShell({
  sidebar,
  workspace,
}: {
  sidebar: React.ReactNode
  workspace: React.ReactNode
}) {
  const [tab, setTab] = useState<MobileTab>('app')

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 sm:gap-4">
      {/* Alternador — só no celular. No desktop os dois aparecem juntos. */}
      <div className="flex gap-1.5 lg:hidden">
        <ToggleButton
          active={tab === 'painel'}
          onClick={() => setTab('painel')}
          icon={Activity}
          label="Atividade"
        />
        <ToggleButton
          active={tab === 'app'}
          onClick={() => setTab('app')}
          icon={PanelsTopLeft}
          label="App"
        />
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 sm:gap-4 lg:flex-row">
        {/* Painel lateral */}
        <aside
          className={cn(
            'bg-sunken w-full shrink-0 flex-col gap-3 overflow-y-auto rounded-[var(--radius-inner)] p-3 lg:flex lg:w-[360px]',
            tab === 'painel' ? 'flex' : 'hidden',
          )}
        >
          {sidebar}
        </aside>

        {/* Workspace: Preview · Banco · Código · Testes */}
        <main
          className={cn(
            'min-h-0 min-w-0 flex-1 lg:block',
            tab === 'app' ? 'block' : 'hidden',
          )}
        >
          {workspace}
        </main>
      </div>
    </div>
  )
}

function ToggleButton({
  active,
  onClick,
  icon: Icon,
  label,
}: {
  active: boolean
  onClick: () => void
  icon: typeof Activity
  label: string
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'inline-flex flex-1 items-center justify-center gap-2 rounded-[var(--radius-control)] px-3 py-2 text-sm font-medium transition-colors',
        active ? 'bg-accent text-accent-ink' : 'bg-surface text-muted',
      )}
    >
      <Icon className="h-4 w-4" />
      {label}
    </button>
  )
}
