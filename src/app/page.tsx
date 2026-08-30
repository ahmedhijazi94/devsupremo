import Link from 'next/link'
import { GitBranch, Zap, Shield, Eye } from 'lucide-react'

export default function HomePage() {
  return (
    <main className="min-h-screen bg-background flex flex-col items-center justify-center px-4">
      <div className="max-w-3xl w-full text-center space-y-8">
        {/* Logo */}
        <div className="space-y-3">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-primary/10 border border-primary/20">
            <Zap className="w-8 h-8 text-primary" />
          </div>
          <h1 className="text-5xl font-bold tracking-tight">
            Supremo
          </h1>
          <p className="text-xl text-muted-foreground max-w-lg mx-auto">
            Crie apps profissionais com segurança máxima via IA.
            Multi-conta, multi-MCP, pipeline de testes automática.
          </p>
        </div>

        {/* Features */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-left">
          <div className="rounded-xl border bg-card p-4 space-y-2">
            <Shield className="w-5 h-5 text-green-500" />
            <h3 className="font-semibold">RLS testado, não prometido</h3>
            <p className="text-sm text-muted-foreground">
              Toda tabela nasce com RLS e um teste que prova que outro usuário
              não lê aquela linha.
            </p>
          </div>
          <div className="rounded-xl border bg-card p-4 space-y-2">
            <Zap className="w-5 h-5 text-yellow-500" />
            <h3 className="font-semibold">Gate que não se contorna</h3>
            <p className="text-sm text-muted-foreground">
              Toda mudança vira pull request. Merge só com tipos, lint, testes,
              cobertura e auditoria verdes.
            </p>
          </div>
          <div className="rounded-xl border bg-card p-4 space-y-2">
            <GitBranch className="w-5 h-5 text-blue-500" />
            <h3 className="font-semibold">De qualquer máquina</h3>
            <p className="text-sm text-muted-foreground">
              Claude Code, Antigravity, Codex ou Cursor — conectam por MCP remoto,
              sem instalar nada.
            </p>
          </div>
          <div className="rounded-xl border bg-card p-4 space-y-2">
            <Eye className="w-5 h-5 text-purple-500" />
            <h3 className="font-semibold">Preview em Tempo Real</h3>
            <p className="text-sm text-muted-foreground">
              O app roda no navegador e sincroniza a cada commit. Sem esperar deploy.
            </p>
          </div>
        </div>

        {/* CTA */}
        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <Link
            href="/login"
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-6 py-3 text-primary-foreground font-semibold hover:bg-primary/90 transition-colors"
          >
            <GitBranch className="w-4 h-4" />
            Entrar com GitHub
          </Link>
          <Link
            href="/login"
            className="inline-flex items-center justify-center gap-2 rounded-lg border px-6 py-3 font-semibold hover:bg-accent transition-colors"
          >
            Entrar com Google
          </Link>
        </div>
      </div>
    </main>
  )
}
