'use client'

import { useState, useTransition } from 'react'
import { Plus, ExternalLink, X } from 'lucide-react'
import { toast } from 'sonner'
import { connectVercelAccount } from '@/actions/vercel'

/**
 * A Vercel não oferece OAuth para aplicações de terceiros criarem projetos em
 * nome do usuário, então a conexão é por token pessoal — como o Supabase.
 */
export function ConnectVercelModal() {
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
    return (
      <button
        onClick={() => setOpen(true)}
        className="inline-flex h-9 items-center gap-2 rounded-lg bg-foreground px-3.5 text-sm font-medium text-background transition-opacity hover:opacity-90"
      >
        <Plus className="h-4 w-4" />
        Conectar Vercel
      </button>
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-md rounded-xl border bg-card p-5 shadow-xl">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 className="font-semibold">Conectar conta Vercel</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              É o que dá preview publicado aos seus projetos — um link por
              pull request, que você pode mandar para outra pessoa.
            </p>
          </div>
          <button
            onClick={() => setOpen(false)}
            className="rounded-md p-1 text-muted-foreground transition-colors hover:text-foreground"
            aria-label="Fechar"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <ol className="mb-4 space-y-1.5 text-sm text-muted-foreground">
          <li>
            1. Abra{' '}
            <a
              href="https://vercel.com/account/tokens"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-primary hover:underline"
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
            className="h-10 w-full rounded-lg border bg-background px-3 font-mono text-sm outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-primary/40"
          />

          <p className="text-xs text-muted-foreground">
            O token é guardado cifrado em AES-256-GCM e usado só para criar e
            consultar os seus projetos.
          </p>

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="h-9 rounded-lg border px-3.5 text-sm font-medium transition-colors hover:bg-accent"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={isPending || token.trim().length < 20}
              className="h-9 rounded-lg bg-foreground px-3.5 text-sm font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {isPending ? 'Verificando…' : 'Conectar'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
