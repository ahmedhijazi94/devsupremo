import Link from 'next/link'
import { FolderPlus } from 'lucide-react'

export function EmptyProjects() {
  return (
    <div className="bg-surface flex flex-col items-center justify-center space-y-4 rounded-[var(--radius-inner)] p-16 text-center">
      <div className="bg-sunken flex h-14 w-14 items-center justify-center rounded-2xl">
        <FolderPlus className="text-muted h-7 w-7" />
      </div>
      <div className="space-y-1">
        <h3 className="font-semibold">Nenhum projeto ainda</h3>
        <p className="text-muted max-w-xs text-sm">
          Crie seu primeiro projeto e comece a construir apps com segurança
          máxima via IA.
        </p>
      </div>
      <Link
        href="/projects/new"
        className="bg-accent text-accent-ink hover:bg-accent/90 inline-flex items-center gap-2 rounded-[var(--radius-control)] px-4 py-2 text-sm font-semibold transition-colors"
      >
        Criar primeiro projeto
      </Link>
    </div>
  )
}
