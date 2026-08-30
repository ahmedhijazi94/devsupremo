import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { ProjectCard } from '@/components/dashboard/project-card'
import { EmptyProjects } from '@/components/dashboard/empty-projects'
import { Onboarding } from '@/components/dashboard/onboarding'
import { isSupabaseOAuthAvailable } from '@/actions/accounts'
import { isVercelOAuthAvailable } from '@/actions/vercel'
import { PlusIcon } from 'lucide-react'
import Link from 'next/link'

export default async function DashboardPage() {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) redirect('/login')

  const [
    { data: projects, error },
    github,
    supabaseAccounts,
    vercel,
    supabaseOAuth,
    vercelOAuth,
  ] = await Promise.all([
    supabase
      .from('projects')
      .select('*')
      .eq('user_id', user.id)
      .order('updated_at', { ascending: false }),
    supabase
      .from('github_accounts')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.id),
    supabase
      .from('supabase_accounts')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.id),
    supabase
      .from('vercel_accounts')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.id),
    isSupabaseOAuthAvailable(),
    isVercelOAuthAvailable(),
  ])

  if (error) {
    console.error('[dashboard] falha ao carregar projetos:', error.message)
  }

  const projectList = projects ?? []

  const connections = {
    github: (github.count ?? 0) > 0,
    supabase: (supabaseAccounts.count ?? 0) > 0,
    vercel: (vercel.count ?? 0) > 0,
    supabaseOAuth,
    vercelOAuth,
  }

  // O passo a passo some quando as três estão conectadas — depois disso ele
  // seria só ruído acima da lista de projetos.
  const showOnboarding =
    !connections.github || !connections.supabase || !connections.vercel

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Projetos</h1>
          <p className="text-muted-foreground">
            {projectList.length === 0
              ? 'Nenhum projeto ainda'
              : `${projectList.length} projeto${projectList.length > 1 ? 's' : ''}`}
          </p>
        </div>
        <Link
          href="/projects/new"
          className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          <PlusIcon className="w-4 h-4" />
          Novo projeto
        </Link>
      </div>

      {showOnboarding && <Onboarding status={connections} />}

      {projectList.length === 0 ? (
        !showOnboarding && <EmptyProjects />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {projectList.map((project) => (
            <ProjectCard key={project.id} project={project} />
          ))}
        </div>
      )}
    </div>
  )
}
