import Link from 'next/link'
import { ArrowUpRight, GitBranch, Database, Globe } from 'lucide-react'
import { Pill } from '@/components/ui/pill'
import { formatRelativeTime } from '@/lib/utils'
import type { Project } from '@/types/database'

const STATUS = {
  active: { label: 'Ativo', tone: 'up' as const },
  creating: { label: 'Criando', tone: 'wait' as const },
  error: { label: 'Erro', tone: 'down' as const },
  archived: { label: 'Arquivado', tone: 'neutral' as const },
}

/**
 * Cartão de projeto.
 *
 * Mostra o que o usuário precisa para decidir se entra: nome, estado, e
 * quais das três peças já existem. Detalhe fino fica na tela do projeto.
 */
export function ProjectCard({ project }: { project: Project }) {
  const status = STATUS[project.status] ?? STATUS.active

  const pieces = [
    { icon: GitBranch, on: Boolean(project.github_repo_full_name), label: 'Repositório' },
    { icon: Database, on: Boolean(project.supabase_project_ref), label: 'Banco' },
    { icon: Globe, on: Boolean(project.preview_project_name), label: 'Preview' },
  ]

  return (
    <Link
      href={`/projects/${project.id}`}
      className="group rounded-[var(--radius-inner)] bg-sunken p-4 transition-colors hover:bg-line/40"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-medium">{project.name}</p>
          <p className="mt-0.5 truncate text-xs text-muted">
            {project.github_repo_full_name ?? 'Ainda não provisionado'}
          </p>
        </div>
        <ArrowUpRight className="h-4 w-4 shrink-0 text-muted transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
      </div>

      <div className="mt-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-1.5">
          {pieces.map((piece) => (
            <span
              key={piece.label}
              title={`${piece.label}: ${piece.on ? 'pronto' : 'pendente'}`}
              className={
                piece.on
                  ? 'flex h-7 w-7 items-center justify-center rounded-full bg-surface text-ink'
                  : 'flex h-7 w-7 items-center justify-center rounded-full text-muted/40'
              }
            >
              <piece.icon className="h-3.5 w-3.5" />
            </span>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <span className="text-xs text-muted">
            {formatRelativeTime(project.updated_at)}
          </span>
          <Pill tone={status.tone}>{status.label}</Pill>
        </div>
      </div>
    </Link>
  )
}
