import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { NewProjectForm } from '@/components/projects/new-project-form'

export default async function NewProjectPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // Buscar contas conectadas para os dropdowns
  const [githubRes, supabaseRes] = await Promise.all([
    supabase.from('github_accounts').select('id, login, avatar_url').eq('user_id', user.id),
    supabase.from('supabase_accounts').select('id, org_name, org_slug').eq('user_id', user.id),
  ])

  const githubAccounts = githubRes.data ?? []
  const supabaseAccounts = supabaseRes.data ?? []

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Novo Projeto</h1>
        <p className="text-muted-foreground mt-1">
          O Supremo vai criar o repositório, configurar o banco, gerar toda a estrutura base e fazer o primeiro commit — tudo automaticamente.
        </p>
      </div>

      <NewProjectForm
        githubAccounts={githubAccounts}
        supabaseAccounts={supabaseAccounts}
      />
    </div>
  )
}
