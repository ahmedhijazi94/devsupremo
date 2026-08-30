import { Zap } from 'lucide-react'
import { Card, CardNote } from '@/components/ui/card'
import { LoginForm } from '@/components/auth/login-form'

export const metadata = { title: 'Entrar — Supremo' }

export default function LoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-sm px-7 py-9">
        <div className="mb-7 text-center">
          <span className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-[var(--radius-control)] bg-accent">
            <Zap className="h-5 w-5 text-accent-ink" />
          </span>
          <h1 className="text-2xl font-semibold tracking-tight">Supremo</h1>
          <CardNote className="mt-1.5">
            Entre para gerenciar seus projetos
          </CardNote>
        </div>

        <LoginForm />
      </Card>
    </main>
  )
}
