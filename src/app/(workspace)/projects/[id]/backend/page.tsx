import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { ArrowLeft, Database } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { BackendConsole } from '@/components/projects/backend-console'

export const metadata = { title: 'Dados e serviços · Supremo' }

export default async function ProjectBackendPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')
  const { data: project } = await supabase
    .from('projects')
    .select('id, name, supabase_project_ref')
    .eq('id', id)
    .eq('user_id', user.id)
    .maybeSingle()
  if (!project) notFound()

  return (
    <main className="min-h-dvh p-3 sm:p-5">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-4">
        <Link
          href={`/projects/${id}`}
          className="text-muted hover:text-ink inline-flex w-fit items-center gap-1.5 px-1 text-xs font-medium"
        >
          <ArrowLeft aria-hidden="true" className="h-3.5 w-3.5" /> Voltar para{' '}
          {project.name}
        </Link>
        <header className="bg-surface rounded-[var(--radius-inner)] p-5 sm:p-6">
          <p className="text-muted mb-2 text-xs">{project.name}</p>
          <h1 className="text-ink flex items-center gap-2 text-xl font-semibold tracking-tight">
            <Database aria-hidden="true" className="h-5 w-5" />
            Dados e serviços
          </h1>
          <p className="text-muted mt-2 text-sm">
            Explore o banco, as funções e as execuções do projeto conectado.
          </p>
        </header>
        {project.supabase_project_ref ? (
          <BackendConsole projectId={project.id} />
        ) : (
          <section className="bg-surface rounded-[var(--radius-inner)] p-6">
            <h2 className="font-semibold">Banco ainda não conectado</h2>
            <p className="text-muted mt-2 text-sm">
              Conecte o Supabase na página do projeto para abrir seus dados e
              serviços aqui.
            </p>
            <Link
              className="mt-4 inline-block text-sm underline"
              href={`/projects/${id}`}
            >
              Abrir o projeto
            </Link>
          </section>
        )}
      </div>
    </main>
  )
}
