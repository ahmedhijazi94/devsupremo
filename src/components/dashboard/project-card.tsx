import Link from 'next/link'
import type { Project } from '@/types/database'
import { formatRelativeTime } from '@/lib/utils'
import {
  GitBranch,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Archive,
  ExternalLink,
  Zap,
  ArrowRight,
  Globe,
} from 'lucide-react'
import { ActivateProjectButton } from './activate-project-button'
import { DeleteProjectDialog } from '../projects/delete-project-dialog'

interface ProjectCardProps {
  project: Project
}

const statusConfig = {
  active: {
    icon: CheckCircle2,
    label: 'Ativo',
    color: 'text-emerald-500',
    dot: 'bg-emerald-500',
  },
  creating: {
    icon: Loader2,
    label: 'Criando...',
    color: 'text-amber-500',
    dot: 'bg-amber-500 animate-pulse',
  },
  error: {
    icon: AlertCircle,
    label: 'Erro',
    color: 'text-red-500',
    dot: 'bg-red-500',
  },
  archived: {
    icon: Archive,
    label: 'Arquivado',
    color: 'text-muted-foreground',
    dot: 'bg-zinc-400',
  },
} as const

export function ProjectCard({ project }: ProjectCardProps) {
  const status = statusConfig[project.status] ?? statusConfig.active
  const StatusIcon = status.icon
  const isActive = project.is_active

  return (
    <div className={`relative rounded-xl border bg-card overflow-hidden transition-all duration-200 group hover:shadow-md ${
      isActive ? 'border-violet-500/40 shadow-sm shadow-violet-500/10' : 'hover:border-border/80'
    }`}>
      {/* Active project gradient top bar */}
      {isActive && (
        <div className="absolute top-0 left-0 right-0 h-0.5 bg-gradient-to-r from-violet-500 via-blue-500 to-cyan-500" />
      )}

      <div className="p-5 space-y-4">
        {/* Header */}
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="font-semibold truncate">{project.name}</h3>
              {isActive && (
                <span className="inline-flex items-center gap-1 rounded-full bg-violet-500/10 border border-violet-500/25 px-2 py-0.5 text-[11px] font-medium text-violet-600 dark:text-violet-400 shrink-0">
                  <Zap className="w-2.5 h-2.5" />
                  Ativo
                </span>
              )}
            </div>
            {project.description && (
              <p className="text-sm text-muted-foreground truncate mt-0.5">
                {project.description}
              </p>
            )}
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <span className={`w-2 h-2 rounded-full ${status.dot}`} />
            <span className={`text-xs ${status.color}`}>{status.label}</span>
          </div>
        </div>

        {/* Tech stack + meta */}
        <div className="flex items-center gap-2 flex-wrap">
          <span className="inline-flex items-center gap-1.5 text-[11px] px-2 py-0.5 rounded-md bg-muted text-muted-foreground font-medium">
            <Globe className="w-3 h-3" />
            Next.js 15
          </span>
          <span className="inline-flex items-center gap-1.5 text-[11px] px-2 py-0.5 rounded-md bg-muted text-muted-foreground font-medium">
            <svg className="w-3 h-3" viewBox="0 0 24 24" fill="currentColor">
              <path d="M11.9 1.036c-.015-.986-1.26-1.41-1.874-.637L.764 12.05C.09 12.886.725 14.10 1.764 14.10h9.823l.013 8.864c.015.986 1.26 1.41 1.874.637l9.262-11.652c.673-.835.038-2.053-1.002-2.053h-9.823L11.9 1.036z"/>
            </svg>
            Supabase
          </span>
          {project.github_repo_full_name && (
            <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground ml-auto">
              <GitBranch className="w-3 h-3" />
              {project.active_branch ?? 'main'}
            </span>
          )}
        </div>

        {/* Footer meta */}
        <div className="flex items-center justify-between text-xs text-muted-foreground pt-1 border-t">
          <span>Atualizado {formatRelativeTime(project.updated_at)}</span>
          {project.active_mcp && (
            <span className="text-[11px] font-medium text-violet-600 dark:text-violet-400">
              {project.active_mcp}
            </span>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2">
          <ActivateProjectButton
            projectId={project.id}
            isActive={isActive}
          />
          <Link
            href={`/projects/${project.id}`}
            className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg bg-primary text-primary-foreground px-3 py-1.5 text-xs font-medium hover:bg-primary/90 transition-colors"
          >
            Abrir projeto
            <ArrowRight className="w-3 h-3" />
          </Link>
          {project.preview_url && (
            <a
              href={project.preview_url}
              target="_blank"
              rel="noopener noreferrer"
              className="p-1.5 rounded-lg border hover:bg-accent transition-colors text-muted-foreground hover:text-foreground"
              title="Abrir preview externo"
            >
              <ExternalLink className="w-3.5 h-3.5" />
            </a>
          )}
          <DeleteProjectDialog projectId={project.id} projectName={project.name} />
        </div>
      </div>
    </div>
  )
}
