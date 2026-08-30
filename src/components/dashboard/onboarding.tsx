import Link from 'next/link'
import { Check, ArrowRight, ExternalLink } from 'lucide-react'
import {
  connectGithubFromOnboarding,
  connectSupabaseFromOnboarding,
  connectVercelFromOnboarding,
} from '@/actions/onboarding'
import { cn } from '@/lib/utils'
import { Card } from '@/components/ui/card'

export interface OnboardingStatus {
  github: boolean
  supabase: boolean
  vercel: boolean
  supabaseOAuth: boolean
  vercelOAuth: boolean
}

interface Step {
  key: 'github' | 'supabase' | 'vercel'
  title: string
  description: string
  done: boolean
  oauth: boolean
  action: () => Promise<void>
}

/**
 * Passo a passo de conexão.
 *
 * A ordem importa: sem GitHub não há onde pôr o código, sem Supabase não há
 * banco, e sem Vercel não há preview. Cada passo é uma autorização — quem
 * conecta nunca precisa gerar token, desde que os apps OAuth estejam
 * configurados no ambiente.
 */
export function Onboarding({ status }: { status: OnboardingStatus }) {
  const steps: Step[] = [
    {
      key: 'github',
      title: 'GitHub',
      description: 'Onde o código do projeto vai morar',
      done: status.github,
      oauth: true,
      action: connectGithubFromOnboarding,
    },
    {
      key: 'supabase',
      title: 'Supabase',
      description: 'Banco de dados e autenticação',
      done: status.supabase,
      oauth: status.supabaseOAuth,
      action: connectSupabaseFromOnboarding,
    },
    {
      key: 'vercel',
      title: 'Vercel',
      description: 'Publica o preview de cada mudança',
      done: status.vercel,
      oauth: status.vercelOAuth,
      action: connectVercelFromOnboarding,
    },
  ]

  const remaining = steps.filter((step) => !step.done)
  const ready = remaining.length === 0

  return (
    <Card>
      <header className="mb-5">
        <h2 className="text-lg font-semibold">
          {ready ? 'Tudo conectado' : 'Conecte suas contas'}
        </h2>
        <p className="text-muted mt-1 text-sm">
          {ready
            ? 'Você já pode criar um projeto. Ele nasce com repositório, banco e preview.'
            : `Faltam ${remaining.length} de ${steps.length}. Cada uma é uma autorização — nenhuma pede token.`}
        </p>
      </header>

      <ol className="space-y-2">
        {steps.map((step, index) => (
          <li
            key={step.key}
            className={cn(
              'flex items-center gap-4 rounded-[var(--radius-control)] p-4 transition-colors',
              step.done ? 'bg-sunken' : 'bg-surface shadow-sm',
            )}
          >
            <span
              className={cn(
                'flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
                step.done ? 'bg-up text-up-ink' : 'bg-sunken text-muted',
              )}
            >
              {step.done ? <Check className="h-4 w-4" /> : index + 1}
            </span>

            <div className="min-w-0 flex-1">
              <p
                className={cn('text-sm font-medium', step.done && 'text-muted')}
              >
                {step.title}
              </p>
              <p className="text-muted text-xs">{step.description}</p>
            </div>

            {step.done ? (
              <span className="text-up-ink shrink-0 text-xs font-medium">
                Conectado
              </span>
            ) : step.oauth ? (
              <form action={step.action} className="shrink-0">
                <button
                  type="submit"
                  className="bg-accent text-accent-ink inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-control)] px-3 text-xs font-medium transition-opacity hover:opacity-90"
                >
                  Autorizar
                  <ArrowRight className="h-3.5 w-3.5" />
                </button>
              </form>
            ) : (
              <Link
                href="/accounts"
                className="hover:bg-sunken inline-flex h-8 shrink-0 items-center gap-1.5 rounded-[var(--radius-control)] px-3 text-xs font-medium transition-colors"
              >
                Conectar
                <ExternalLink className="h-3.5 w-3.5" />
              </Link>
            )}
          </li>
        ))}
      </ol>

      {ready && (
        <Link
          href="/projects/new"
          className="bg-accent text-accent-ink hover:bg-accent/90 mt-5 inline-flex h-10 items-center gap-2 rounded-[var(--radius-control)] px-4 text-sm font-semibold transition-colors"
        >
          Criar primeiro projeto
          <ArrowRight className="h-4 w-4" />
        </Link>
      )}
    </Card>
  )
}
