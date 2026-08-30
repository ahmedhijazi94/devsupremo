'use client'

import { useEffect, useState, useTransition } from 'react'
import { ExternalLink, TriangleAlert } from 'lucide-react'
import { toast } from 'sonner'
import { scaffoldProject } from '@/actions/scaffold'
import { checkVercelGitAccess, type GitAccessCheck } from '@/actions/vercel'
import { ScaffoldButton } from './scaffold-button'

interface ScaffoldFormProps {
  projectId: string
  disabled: boolean
  /** Dono do repositório que será criado, para checar o acesso da Vercel. */
  githubOwner: string | null
}

export function ScaffoldForm({
  projectId,
  disabled,
  githubOwner,
}: ScaffoldFormProps) {
  const [isPending, startTransition] = useTransition()
  const [access, setAccess] = useState<GitAccessCheck | null>(null)

  // Checar antes evita provisionar e só então descobrir que a Vercel não
  // enxerga aquela conta do GitHub — com uma mensagem que manda procurar
  // erro de digitação.
  useEffect(() => {
    if (!githubOwner) return
    let active = true

    void checkVercelGitAccess(githubOwner).then((result) => {
      if (active) setAccess(result)
    })

    return () => {
      active = false
    }
  }, [githubOwner])

  return (
    <div className="space-y-3">
      {access?.status === 'missing_access' && (
        <div className="border-wait bg-wait/30 flex gap-3 rounded-[var(--radius-control)] border p-3.5">
          <TriangleAlert className="text-wait-ink mt-0.5 h-4 w-4 shrink-0" />
          <div className="space-y-1.5 text-sm">
            <p className="font-medium">
              A Vercel ainda não enxerga a conta {access.owner}
            </p>
            <p className="text-muted">
              Ela precisa ler o repositório para publicar o preview. É uma
              autorização entre a Vercel e o GitHub, feita uma vez por conta.
              Sem ela o projeto é criado, mas fica sem preview.
            </p>
            {access.installUrl && (
              <a
                href={access.installUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-ink inline-flex items-center gap-1.5 font-medium hover:underline"
              >
                Autorizar a Vercel em {access.owner}
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            )}
          </div>
        </div>
      )}

      <form
        action={() => {
          startTransition(async () => {
            const result = await scaffoldProject(projectId)

            if (result.error) {
              toast.error(result.error, { duration: 10_000 })
              return
            }

            if (result.warnings && result.warnings.length > 0) {
              toast.warning('Provisionado, com ressalvas', {
                description: result.warnings.join(' '),
                duration: 20_000,
              })
              return
            }

            toast.success('Projeto provisionado', {
              description:
                'Repositório, banco e preview prontos. O CI já está rodando.',
            })
          })
        }}
      >
        <ScaffoldButton disabled={disabled || isPending} />
      </form>
    </div>
  )
}
