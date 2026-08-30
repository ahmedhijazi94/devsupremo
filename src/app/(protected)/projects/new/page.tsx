import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { NewProjectForm } from '@/components/projects/new-project-form'

export default async function NewProjectPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  return (
    <div className="space-y-6 max-w-2xl mx-auto">
      <div>
        <h1 className="text-2xl font-bold">Novo Projeto</h1>
        <p className="text-muted mt-1">
          Crie o registro do seu projeto. Você conectará as contas e a infraestrutura na próxima tela.
        </p>
      </div>

      <NewProjectForm />
    </div>
  )
}
