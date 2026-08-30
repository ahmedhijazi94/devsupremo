import Link from 'next/link'
import {
  Zap,
  ShieldCheck,
  GitPullRequest,
  Globe,
  ArrowRight,
} from 'lucide-react'
import { Card, CardTitle, CardNote } from '@/components/ui/card'
import { ButtonLink } from '@/components/ui/button'

const PILLARS = [
  {
    icon: ShieldCheck,
    title: 'RLS testado, não prometido',
    body: 'Toda tabela nasce com Row Level Security e um teste que prova que outro usuário não lê aquela linha.',
  },
  {
    icon: GitPullRequest,
    title: 'Gate que não se contorna',
    body: 'Toda mudança vira pull request. Merge só com tipos, lint, testes, cobertura e auditoria verdes.',
  },
  {
    icon: Zap,
    title: 'De qualquer máquina',
    body: 'Claude Code, Antigravity, Codex ou Cursor conectam por MCP remoto, sem instalar nada.',
  },
  {
    icon: Globe,
    title: 'Preview publicado',
    body: 'Cada mudança ganha um link que abre no painel e pode ser mandado para qualquer pessoa.',
  },
]

export default function HomePage() {
  return (
    <div className="min-h-screen p-3 sm:p-4">
      <div className="mx-auto flex max-w-5xl flex-col gap-3 sm:gap-4">
        <nav className="bg-surface flex h-16 items-center justify-between rounded-[var(--radius-card)] px-5">
          <span className="flex items-center gap-2.5">
            <span className="bg-accent flex h-8 w-8 items-center justify-center rounded-[var(--radius-control)]">
              <Zap className="text-accent-ink h-4 w-4" />
            </span>
            <span className="text-lg font-semibold tracking-tight">
              Supremo
            </span>
          </span>

          <ButtonLink href="/login" size="sm">
            Entrar
            <ArrowRight className="h-4 w-4" />
          </ButtonLink>
        </nav>

        <Card className="px-6 py-14 text-center sm:px-12 sm:py-20">
          <h1 className="mx-auto max-w-2xl text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
            Apps criados por IA, com a engenharia que eles normalmente não têm
          </h1>
          <CardNote className="mx-auto mt-5 max-w-xl text-base">
            O repositório e o banco são seus. Nenhuma mudança entra sem passar
            pelos gates. E o agente que você já usa continua sendo o seu.
          </CardNote>

          <ButtonLink href="/login" className="mt-8">
            Começar
            <ArrowRight className="h-4 w-4" />
          </ButtonLink>
        </Card>

        <div className="grid gap-3 sm:gap-4 md:grid-cols-2">
          {PILLARS.map((pillar) => (
            <Card key={pillar.title}>
              <span className="bg-sunken mb-4 flex h-10 w-10 items-center justify-center rounded-full">
                <pillar.icon className="h-5 w-5" />
              </span>
              <CardTitle>{pillar.title}</CardTitle>
              <CardNote className="mt-1.5">{pillar.body}</CardNote>
            </Card>
          ))}
        </div>

        <Card className="text-center">
          <CardNote>
            Já tem conta?{' '}
            <Link
              href="/login"
              className="text-ink font-medium underline underline-offset-2"
            >
              Entrar
            </Link>
          </CardNote>
        </Card>
      </div>
    </div>
  )
}
