'use client'

import { useState, useTransition } from 'react'
import { KeyRound, Plus, Trash2, ShieldCheck, AlertTriangle } from 'lucide-react'
import { toast } from 'sonner'
import { createMcpToken, revokeMcpToken } from '@/actions/mcp-tokens'
import { CopyButton } from '@/components/ui/copy-button'

export interface TokenRow {
  id: string
  name: string
  token_prefix: string
  last_used_at: string | null
  expires_at: string | null
  created_at: string
}

interface TokenManagerProps {
  tokens: TokenRow[]
  mcpUrl: string
}

export function TokenManager({ tokens, mcpUrl }: TokenManagerProps) {
  const [name, setName] = useState('')
  const [freshToken, setFreshToken] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  function handleCreate(event: React.FormEvent) {
    event.preventDefault()
    if (!name.trim()) {
      toast.error('Dê um nome ao token — algo como "meu notebook".')
      return
    }

    startTransition(async () => {
      const result = await createMcpToken({ name: name.trim() })
      if (result.error) {
        toast.error(result.error)
        return
      }
      setFreshToken(result.token ?? null)
      setName('')
      toast.success('Token criado. Copie agora — ele não aparece de novo.')
    })
  }

  function handleRevoke(id: string, tokenName: string) {
    startTransition(async () => {
      const result = await revokeMcpToken(id)
      if (result.error) {
        toast.error(result.error)
        return
      }
      toast.success(`Token "${tokenName}" revogado.`)
    })
  }

  return (
    <div className="space-y-4">
      {freshToken && (
        <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-5 space-y-3">
          <div className="flex items-center gap-2 text-emerald-600 dark:text-emerald-400">
            <ShieldCheck className="w-4 h-4 shrink-0" />
            <h3 className="font-semibold text-sm">
              Token criado — copie agora
            </h3>
          </div>
          <p className="text-sm text-muted-foreground">
            Este valor não é recuperável. O Supremo guarda apenas o hash; se você
            perder o token, gere outro.
          </p>
          <div className="relative">
            <pre className="bg-background border rounded-lg p-3 pr-12 text-xs font-mono overflow-x-auto">
              {freshToken}
            </pre>
            <CopyButton
              value={freshToken}
              className="absolute top-2.5 right-2.5"
            />
          </div>
          <div className="relative">
            <p className="text-xs font-medium text-muted-foreground mb-1.5">
              Conecte de qualquer máquina:
            </p>
            <pre className="bg-background border rounded-lg p-3 pr-12 text-xs font-mono overflow-x-auto">
              {`claude mcp add --transport http supremo ${mcpUrl} --header "Authorization: Bearer ${freshToken}"`}
            </pre>
            <CopyButton
              value={`claude mcp add --transport http supremo ${mcpUrl} --header "Authorization: Bearer ${freshToken}"`}
              className="absolute top-8 right-2.5"
            />
          </div>
          <button
            onClick={() => setFreshToken(null)}
            className="text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
          >
            Já copiei, pode esconder
          </button>
        </div>
      )}

      <form
        onSubmit={handleCreate}
        className="flex flex-col sm:flex-row gap-2"
      >
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Nome do token — ex: notebook do trabalho"
          maxLength={60}
          className="flex-1 h-10 rounded-lg border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-primary/40 transition-shadow"
        />
        <button
          type="submit"
          disabled={isPending}
          className="h-10 inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors shrink-0"
        >
          <Plus className="w-4 h-4" />
          Gerar token
        </button>
      </form>

      {tokens.length === 0 ? (
        <div className="rounded-xl border border-dashed p-6 text-center">
          <KeyRound className="w-6 h-6 mx-auto text-muted-foreground mb-2" />
          <p className="text-sm text-muted-foreground">
            Nenhum token ainda. Gere um para conectar o seu agente de qualquer
            computador.
          </p>
        </div>
      ) : (
        <ul className="border rounded-xl divide-y overflow-hidden">
          {tokens.map((token) => {
            const expired =
              token.expires_at !== null &&
              new Date(token.expires_at) < new Date()

            return (
              <li
                key={token.id}
                className="flex items-center gap-3 p-3.5 bg-card"
              >
                <KeyRound className="w-4 h-4 text-muted-foreground shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium truncate">
                      {token.name}
                    </span>
                    <code className="text-[11px] font-mono text-muted-foreground bg-secondary px-1.5 py-0.5 rounded">
                      {token.token_prefix}…
                    </code>
                    {expired && (
                      <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-500">
                        <AlertTriangle className="w-3 h-3" />
                        expirado
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {token.last_used_at
                      ? `Último uso ${formatRelative(token.last_used_at)}`
                      : 'Nunca usado'}
                    {' · '}
                    criado {formatRelative(token.created_at)}
                  </p>
                </div>
                <button
                  onClick={() => handleRevoke(token.id, token.name)}
                  disabled={isPending}
                  title={`Revogar "${token.name}"`}
                  className="p-2 rounded-lg text-muted-foreground hover:text-red-500 hover:bg-red-500/10 disabled:opacity-50 transition-colors shrink-0"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const minutes = Math.floor(diff / 60_000)

  if (minutes < 1) return 'agora'
  if (minutes < 60) return `há ${minutes} min`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `há ${hours}h`

  const days = Math.floor(hours / 24)
  if (days < 30) return `há ${days}d`

  return new Date(iso).toLocaleDateString('pt-BR')
}
