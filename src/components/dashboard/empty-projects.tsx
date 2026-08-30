import Link from 'next/link'
import { FolderPlus } from 'lucide-react'

export function EmptyProjects() {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-line border-dashed bg-surface p-16 text-center space-y-4">
      <div className="w-14 h-14 rounded-2xl bg-sunken border border-primary/10 flex items-center justify-center">
        <FolderPlus className="w-7 h-7 text-muted" />
      </div>
      <div className="space-y-1">
        <h3 className="font-semibold">Nenhum projeto ainda</h3>
        <p className="text-sm text-muted max-w-xs">
          Crie seu primeiro projeto e comece a construir apps com segurança máxima via IA.
        </p>
      </div>
      <Link
        href="/projects/new"
        className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink hover:bg-accent/90 transition-colors"
      >
        Criar primeiro projeto
      </Link>
    </div>
  )
}
