import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'

/**
 * Layout do workspace de um projeto.
 *
 * Sem a barra lateral de propósito: aqui o preview é o conteúdo, e a
 * navegação do resto do app roubaria largura dele. A volta para o painel
 * fica no cabeçalho da própria página.
 */
export default async function WorkspaceLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) redirect('/login')

  return <div className="h-screen overflow-hidden bg-surface">{children}</div>
}
