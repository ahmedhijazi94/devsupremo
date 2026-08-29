import Link from 'next/link'
import {
  GitPullRequest,
  GitCommit,
  CheckCircle2,
  XCircle,
  Loader2,
  Clock,
  FileDiff,
  Sparkles,
} from 'lucide-react'
import { formatRelativeTime, truncate } from '@/lib/utils'
import type { Json } from '@/types/database'

export interface ActivityItem {
  id: string
  role: 'user' | 'assistant'
  content: string
  branch: string | null
  pr_number: number | null
  pr_url: string | null
  commit_sha: string | null
  files_changed: Json | null
  pipeline_status: 'pending' | 'running' | 'passed' | 'failed' | null
  mcp_used: string | null
  created_at: string
}

interface ActivityFeedProps {
  items: ActivityItem[]
  repoFullName: string | null
}

const PIPELINE_STATES = {
  passed: {
    icon: CheckCircle2,
    label: 'Gates verdes',
    className: 'text-emerald-600 dark:text-emerald-400',
    dot: 'bg-emerald-500',
  },
  failed: {
    icon: XCircle,
    label: 'Gate vermelho',
    className: 'text-red-600 dark:text-red-400',
    dot: 'bg-red-500',
  },
  running: {
    icon: Loader2,
    label: 'Rodando',
    className: 'text-amber-600 dark:text-amber-400',
    dot: 'bg-amber-500',
  },
  pending: {
    icon: Clock,
    label: 'Na fila',
    className: 'text-muted-foreground',
    dot: 'bg-muted-foreground',
  },
} as const

function countFiles(filesChanged: Json | null): number {
  return Array.isArray(filesChanged) ? filesChanged.length : 0
}

export function ActivityFeed({ items, repoFullName }: ActivityFeedProps) {
  if (items.length === 0) {
    return (
      <div className="rounded-xl border border-dashed p-8 text-center">
        <Sparkles className="mx-auto mb-3 h-6 w-6 text-muted-foreground" />
        <p className="text-sm font-medium">Nenhuma mudança ainda</p>
        <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
          Conecte um agente em{' '}
          <Link href="/mcps" className="underline underline-offset-2">
            Integração MCP
          </Link>{' '}
          e peça a primeira alteração. Cada proposta aparece aqui com o PR e o
          resultado dos gates.
        </p>
      </div>
    )
  }

  return (
    <ol className="relative space-y-0">
      {items.map((item, index) => {
        const state = item.pipeline_status
          ? PIPELINE_STATES[item.pipeline_status]
          : null
        const fileCount = countFiles(item.files_changed)
        const isLast = index === items.length - 1

        return (
          <li key={item.id} className="relative flex gap-4 pb-5">
            {/* Trilho da timeline */}
            {!isLast && (
              <span
                aria-hidden
                className="absolute left-[7px] top-5 h-full w-px bg-border"
              />
            )}

            <span
              aria-hidden
              className={`relative mt-1.5 h-[15px] w-[15px] shrink-0 rounded-full border-2 border-background ring-1 ring-border ${
                state?.dot ?? 'bg-muted-foreground'
              }`}
            />

            <div className="min-w-0 flex-1 space-y-1.5">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <p className="text-sm font-medium leading-snug">
                  {truncate(item.content, 120)}
                </p>
                <time
                  dateTime={item.created_at}
                  className="shrink-0 text-xs text-muted-foreground tabular-nums"
                >
                  {formatRelativeTime(item.created_at)}
                </time>
              </div>

              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
                {state && (
                  <span
                    className={`inline-flex items-center gap-1 font-medium ${state.className}`}
                  >
                    <state.icon
                      className={`h-3.5 w-3.5 ${
                        item.pipeline_status === 'running' ? 'animate-spin' : ''
                      }`}
                    />
                    {state.label}
                  </span>
                )}

                {item.pr_url && item.pr_number !== null && (
                  <a
                    href={item.pr_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 hover:text-foreground transition-colors"
                  >
                    <GitPullRequest className="h-3.5 w-3.5" />#{item.pr_number}
                  </a>
                )}

                {item.commit_sha && repoFullName && (
                  <a
                    href={`https://github.com/${repoFullName}/commit/${item.commit_sha}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 font-mono hover:text-foreground transition-colors"
                  >
                    <GitCommit className="h-3.5 w-3.5" />
                    {item.commit_sha.slice(0, 7)}
                  </a>
                )}

                {fileCount > 0 && (
                  <span className="inline-flex items-center gap-1">
                    <FileDiff className="h-3.5 w-3.5" />
                    {fileCount} arquivo{fileCount === 1 ? '' : 's'}
                  </span>
                )}

                {item.branch && (
                  <code className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[11px]">
                    {item.branch}
                  </code>
                )}

                {item.mcp_used && (
                  <span className="text-[11px] opacity-70">
                    via {item.mcp_used}
                  </span>
                )}
              </div>
            </div>
          </li>
        )
      })}
    </ol>
  )
}
