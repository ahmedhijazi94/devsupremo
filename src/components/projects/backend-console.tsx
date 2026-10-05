'use client'

import { useState } from 'react'
import { BackendAutomation } from './automation-panel'
import { BackendStorageManager } from './backend-storage-manager'
import { BackendIntegrationsManager } from './backend-integrations-manager'
import { BackendUsersManager, BackendFunctionsManager } from './backend-operation-controls'
import {
  Table2,
  Code2,
  Zap,
  Clock3,
  ScrollText,
  ChartNoAxesCombined,
  Users,
  FolderOpen,
  type LucideIcon,
} from 'lucide-react'
import {
  BackendTables,
  BackendSql,
  BackendJobs,
  BackendLogs,
  BackendUsage,
} from './backend-panels'

const sections = [
  {
    id: 'integrations', label: 'Integrações', icon: Zap,
    description: 'Conecte os serviços preparados pelo agente e acompanhe os resultados.', component: BackendIntegrationsManager,
  },
  {
    id: 'automation', label: 'Automação', icon: Zap,
    description: 'Autorize o agente uma vez e acompanhe o resultado das operações.', component: BackendAutomation,
  },
  {
    id: 'tables',
    label: 'Tabelas',
    icon: Table2,
    description: 'Abra as tabelas e consulte os registros do banco.',
    component: BackendTables,
  },
  {
    id: 'sql',
    label: 'Editor SQL',
    icon: Code2,
    description: 'Execute consultas de leitura no banco conectado.',
    component: BackendSql,
  },
  {
    id: 'functions',
    label: 'Edge Functions',
    icon: Zap,
    description: 'Acompanhe as funções publicadas na nuvem.',
    component: BackendFunctionsManager,
  },
  {
    id: 'jobs',
    label: 'Agendamentos',
    icon: Clock3,
    description: 'Veja as tarefas recorrentes e seu histórico de execução.',
    component: BackendJobs,
  },
  {
    id: 'logs',
    label: 'Logs',
    icon: ScrollText,
    description: 'Consulte eventos recentes para entender o que aconteceu.',
    component: BackendLogs,
  },
  {
    id: 'usage',
    label: 'Uso',
    icon: ChartNoAxesCombined,
    description: 'Indicadores fornecidos pelo banco conectado.',
    component: BackendUsage,
  },
  {
    id: 'users',
    label: 'Usuários',
    icon: Users,
    description: 'Contas cadastradas no aplicativo.',
    component: BackendUsersManager,
  },
  {
    id: 'storage',
    label: 'Armazenamento',
    icon: FolderOpen,
    description: 'Espaços de arquivos do projeto.',
    component: BackendStorageManager,
  },
] satisfies Array<{
  id: string
  label: string
  icon: LucideIcon
  description: string
  component: React.ComponentType<{ projectId: string }>
}>

export function BackendConsole({ projectId, initialSection = 'tables' }: { projectId: string; initialSection?: string }) {
  return <ProjectBackendConsole key={`${projectId}:${initialSection}`} projectId={projectId} initialSection={initialSection} />
}

function ProjectBackendConsole({ projectId, initialSection }: { projectId: string; initialSection: string }) {
  const [selected, setSelected] = useState(sections.some(section => section.id === initialSection) ? initialSection : 'tables')
  const section = sections.find((item) => item.id === selected) ?? sections[0]!
  const Panel = section.component
  return (
    <div className="grid min-w-0 gap-4 lg:grid-cols-[190px_minmax(0,1fr)]">
      <nav
        aria-label="Seções de dados e serviços"
        className="bg-surface flex flex-wrap gap-1 self-start rounded-[var(--radius-inner)] p-2 lg:flex-col"
      >
        {sections.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            aria-current={id === selected ? 'page' : undefined}
            onClick={() => setSelected(id)}
            className={`inline-flex items-center gap-2 rounded-xl px-3 py-3 text-left text-xs font-medium transition-colors ${id === selected ? 'bg-accent text-accent-ink' : 'text-ink-soft hover:bg-sunken'}`}
          >
            <Icon aria-hidden="true" className="h-4 w-4 shrink-0" />
            {label}
          </button>
        ))}
      </nav>
      <section
        aria-label={section.label}
        className="bg-surface min-w-0 rounded-[var(--radius-inner)] p-4 sm:p-6"
      >
        <h2 className="text-lg font-semibold tracking-tight">
          {section.label}
        </h2>
        <p className="text-muted mt-1 mb-6 text-sm">{section.description}</p>
        <Panel key={selected} projectId={projectId} />
      </section>
    </div>
  )
}
