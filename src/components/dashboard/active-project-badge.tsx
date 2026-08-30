'use client'

import Link from 'next/link'
import { CheckCircle, Circle, ChevronDown } from 'lucide-react'
import type { Project } from '@/types/database'

interface ActiveProjectBadgeProps {
  project: Pick<Project, 'id' | 'name' | 'active_mcp' | 'status'> | null
}

export function ActiveProjectBadge({ project }: ActiveProjectBadgeProps) {
  if (!project) {
    return (
      <Link
        href="/projects"
        className="text-muted hover:text-ink hover:border-foreground/30 flex items-center gap-2 rounded-[var(--radius-control)] border-dashed px-3 py-2 text-sm transition-colors"
      >
        <Circle className="h-3 w-3" />
        <span className="truncate">Nenhum projeto ativo</span>
      </Link>
    )
  }

  return (
    <Link
      href={`/projects/${project.id}`}
      className="bg-sunken hover:bg-accent/10 flex items-center gap-2 rounded-[var(--radius-control)] px-3 py-2 text-sm transition-colors"
    >
      <CheckCircle className="h-3 w-3 shrink-0 text-green-500" />
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{project.name}</p>
        <p className="text-muted text-xs">{project.active_mcp}</p>
      </div>
      <ChevronDown className="text-muted h-3 w-3 shrink-0" />
    </Link>
  )
}
