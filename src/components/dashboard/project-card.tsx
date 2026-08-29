import Link from 'next/link'
import type { Project } from '@/types/database'
import { formatRelativeTime } from '@/lib/utils'
import {
  GitBranch,
  Circle,
  CheckCircle,
  AlertCircle,
  Loader2,
  ExternalLink,
  Zap,
} from 'lucide-react'
import { ActivateProjectButton } from './activate-project-button'
import { DeleteProjectDialog } from '../projects/delete-project-dialog'

interface ProjectCardProps {
  project: Project
}

const statusConfig = {
  active: { icon: CheckCircle, label: 'Ativo', color: 'text-green-500' },
  creating: { icon: Loader2, label: 'Criando...', color: 'text-yellow-500' },
  error: { icon: AlertCircle, label: 'Erro', color: 'text-red-500' },
  archived: { icon: Circle, label: 'Arquivado', color: 'text-muted-foreground' },
} as const

export function ProjectCard({ project }: ProjectCardProps) {
  const status = statusConfig[project.status] ?? statusConfig.active
  const StatusIcon = status.icon

  return (
    <div className="rounded-xl border bg-card p-5 space-y-4 hover:border-primary/30 transition-colors group">
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="font-semibold truncate">{project.name}</h3>
            {project.is_active && (
              <span className="inline-flex items-center gap-1 rounded-full bg-green-500/10 border border-green-500/20 px-2 py-0.5 text-xs font-medium text-green-600">
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
        <StatusIcon
          className={`w-4 h-4 shrink-0 mt-0.5 ${status.color} ${
            project.status === 'creating' ? 'animate-spin' : ''
          }`}
        />
      </div>

      {/* Meta */}
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        {project.github_repo_full_name && (
          <span className="flex items-center gap-1">
            <GitBranch className="w-3 h-3" />
            {project.active_branch}
          </span>
        )}
        <span className="flex items-center gap-1">
          <Circle className="w-2 h-2 fill-current" />
          {project.active_mcp}
        </span>
        <span className="ml-auto">{formatRelativeTime(project.updated_at)}</span>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2 pt-1">
        <ActivateProjectButton
          projectId={project.id}
          isActive={project.is_active}
        />
        <Link
          href={`/projects/${project.id}`}
          className="flex-1 inline-flex items-center justify-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-medium hover:bg-accent transition-colors"
        >
          Abrir
        </Link>
        {project.preview_url && (
          <a
            href={project.preview_url}
            target="_blank"
            rel="noopener noreferrer"
            className="p-1.5 rounded-lg border hover:bg-accent transition-colors text-muted-foreground hover:text-foreground"
          >
            <ExternalLink className="w-3.5 h-3.5" />
          </a>
        )}
        <DeleteProjectDialog projectId={project.id} projectName={project.name} />
      </div>
    </div>
  )
}
