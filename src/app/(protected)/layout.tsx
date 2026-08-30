import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { TopNav, MobileNav } from '@/components/dashboard/top-nav'

/**
 * Casca das telas de gestão.
 *
 * O conteúdo flutua sobre o fundo em cartões, com a navegação como o
 * primeiro deles — mesma linguagem, sem uma barra fixa disputando largura.
 */
export default async function ProtectedLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) redirect('/login')

  return (
    <div className="min-h-screen p-3 sm:p-4">
      <div className="mx-auto flex max-w-[1600px] flex-col gap-3 sm:gap-4">
        <TopNav user={user} />
        <MobileNav />
        <main>{children}</main>
      </div>
    </div>
  )
}
