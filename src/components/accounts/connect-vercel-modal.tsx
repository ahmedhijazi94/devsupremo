'use client'

import { useState, useTransition } from 'react'
import { Plus, ExternalLink, X } from 'lucide-react'
import { toast } from 'sonner'
import { connectVercelAccount, startVercelOAuth } from '@/actions/vercel'

interface ConnectVercelModalProps {
  /** Sem a Integration configurada no ambiente, só resta o token pessoal. */
  oauthAvailable: boolean
}

/**
 * Conexão da conta Vercel.
 *
 * Com a Integration configurada, é um clique — mesmo fluxo do GitHub e do
 * Supabase. Sem ela, cai no token pessoal, que funciona igual mas dá mais
 * trabalho a quem conecta.
 */
export function ConnectVercelModal({
  oauthAvailable,
}: ConnectVercelModalProps) {
  const [open, setOpen] = useState(false)
  const [token, setToken] = useState('')
  const [isPending, startTransition] = useTransition()

  function submit(event: React.FormEvent) {
    event.preventDefault()

    startTransition(async () => {
      const result = await connectVercelAccount({ token: token.trim() })

      if (result.error) {
        toast.error(result.error)
        return
      }

      toast.success(`Conta ${result.accountName} conectada`, {
        description: 'Projetos novos já nascem com preview publicado.',
      })
      setToken('')
      setOpen(false)
    })
  }

  if (!open) {
    if (oauthAvailable) {
      return (
        <form action={() => startVercelOAuth()}>
          <button
            type="submit"
            className="bg-accent text-accent-ink inline-flex h-9 items-center gap-2 rounded-[var(--radius-control)] px-3.5 text-sm font-medium transition-opacity hover:opacity-90"
          >
            <Plus className="h-4 w-4" />
            Conectar Vercel
          </button>
        </form>
      )
    }

    return (
      <button
        onClick={() => setOpen(true)}
        className="bg-accent text-accent-ink inline-flex h-9 items-center gap-2 rounded-[var(--radius-control)] px-3.5 text-sm font-medium transition-opacity hover:opacity-90"
      >
        <Plus className="h-4 w-4" />
        Conectar Vercel
      </button>
    )
  }

  return (
    <div className="bg-ink/25 fixed inset-0 z-50 flex items-center justify-center p-4 backdrop-blur-sm">
      <div className="bg-surface w-full max-w-md rounded-[var(--radius-inner)] p-5 shadow-xl">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 className="font-semibold">Conectar conta Vercel</h2>
            <p className="text-muted mt-1 text-sm">
              É o que dá preview publicado aos seus projetos — um link por pull
              request, que você pode mandar para outra pessoa.
            </p>
          </div>
          <button
            onClick={() => setOpen(false)}
            className="text-muted hover:text-ink rounded-md p-1 transition-colors"
            aria-label="Fechar"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <ol className="text-muted mb-4 space-y-1.5 text-sm">
          <li>
            1. Abra{' '}
            <a
              href="https://vercel.com/account/tokens"
              target="_blank"
              rel="noopener noreferrer"
              className="text-ink inline-flex items-center gap-1 hover:underline"
            >
              vercel.com/account/tokens
              <ExternalLink className="h-3 w-3" />
            </a>
          </li>
          <li>2. Create Token, escopo da conta ou do time</li>
          <li>3. Cole o valor aqui</li>
        </ol>

        <form onSubmit={submit} className="space-y-3">
          <input
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder="Token da Vercel"
            autoComplete="off"
            className="bg-sunken focus-visible:ring-line-strong h-10 w-full rounded-[var(--radius-control)] px-3 font-mono text-sm transition-shadow outline-none focus-visible:ring-2"
          />

          <p className="text-muted text-xs">
            O token é guardado cifrado em AES-256-GCM e usado só para criar e
            consultar os seus projetos.
          </p>

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="hover:bg-sunken h-9 rounded-[var(--radius-control)] px-3.5 text-sm font-medium transition-colors"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={isPending || token.trim().length < 20}
              className="bg-accent text-accent-ink h-9 rounded-[var(--radius-control)] px-3.5 text-sm font-medium transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {isPending ? 'Verificando…' : 'Conectar'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
