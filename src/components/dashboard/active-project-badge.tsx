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
        className="flex items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-sm text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-colors"
      >
        <Circle className="w-3 h-3" />
        <span className="truncate">Nenhum projeto ativo</span>
      </Link>
    )
  }

  return (
    <Link
      href={`/projects/${project.id}`}
      className="flex items-center gap-2 rounded-lg bg-primary/5 border border-primary/20 px-3 py-2 text-sm hover:bg-primary/10 transition-colors"
    >
      <CheckCircle className="w-3 h-3 text-green-500 shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="font-medium truncate">{project.name}</p>
        <p className="text-xs text-muted-foreground">{project.active_mcp}</p>
      </div>
      <ChevronDown className="w-3 h-3 text-muted-foreground shrink-0" />
    </Link>
  )
}
