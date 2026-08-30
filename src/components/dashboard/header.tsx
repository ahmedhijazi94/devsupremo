import { Bell } from 'lucide-react'

/**
 * Sair fica só na barra lateral, junto da identificação de quem está
 * logado. Dois botões para a mesma ação, em cantos opostos, é ruído.
 */
export function DashboardHeader() {
  return (
    <header className="flex h-14 shrink-0 items-center justify-end border-b bg-card/50 px-6 backdrop-blur-sm">
      <button
        title="Notificações"
        className="rounded-lg p-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <Bell className="h-4 w-4" />
      </button>
    </header>
  )
}
