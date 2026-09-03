import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'

/**
 * Layout do workspace de um projeto.
 *
 * Sem a barra lateral de propósito: aqui a tela do projeto é o conteúdo, e a
 * navegação do resto do app roubaria largura dela. A volta para o painel
 * fica no cabeçalho da própria página.
 *
 * `min-h-screen` (não `h-screen overflow-hidden`): a página cresce com o
 * conteúdo — Projeto, Desenvolvimento Local, Histórico, Atividade — e é o
 * documento inteiro que rola, como qualquer outra tela do app. Um
 * `h-screen overflow-hidden` aqui é resíduo de quando esta rota hospedava um
 * preview/IDE de altura fixa (a página já não é mais isso — ver o comentário
 * "control plane, NÃO IDE" em `projects/[id]/page.tsx`); sobrevivendo sozinho
 * ele trava a rolagem da página inteira, cortando o fim do Histórico/Atividade.
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

  return <div className="bg-canvas min-h-screen">{children}</div>
}
