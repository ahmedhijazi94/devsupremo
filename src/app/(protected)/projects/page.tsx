import { redirect } from 'next/navigation'
import { Plus } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { Card, CardTitle, CardNote } from '@/components/ui/card'
import { ButtonLink } from '@/components/ui/button'
import { ProjectCard } from '@/components/dashboard/project-card'

export const metadata = { title: 'Projetos — Supremo' }

export default async function ProjectsPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: projects } = await supabase
    .from('projects')
    .select('*')
    .eq('user_id', user.id)
    .order('updated_at', { ascending: false })

  const list = projects ?? []

  return (
    <div className="space-y-3 sm:space-y-4">
      <Card className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <CardTitle className="text-xl">Projetos</CardTitle>
          <CardNote className="mt-1">
            {list.length === 0
              ? 'Nenhum projeto ainda'
              : `${list.length} projeto${list.length > 1 ? 's' : ''}`}
          </CardNote>
        </div>

        <ButtonLink href="/projects/new">
          <Plus className="h-4 w-4" />
          Novo projeto
        </ButtonLink>
      </Card>

      <Card>
        {list.length === 0 ? (
          <div className="bg-sunken rounded-[var(--radius-inner)] px-6 py-16 text-center">
            <p className="font-medium">Comece pelo primeiro</p>
            <CardNote className="mx-auto mt-1.5 max-w-md">
              Um projeto novo nasce com repositório no GitHub, banco com Row
              Level Security, gates no CI e preview publicado — sem você
              configurar nada disso.
            </CardNote>
            <ButtonLink href="/projects/new" className="mt-6" size="sm">
              <Plus className="h-4 w-4" />
              Criar projeto
            </ButtonLink>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {list.map((project) => (
              <ProjectCard key={project.id} project={project} />
            ))}
          </div>
        )}
      </Card>
    </div>
  )
}
