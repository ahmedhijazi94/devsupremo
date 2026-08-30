'use client'

import { useState, useTransition } from 'react'
import {
  KeyRound,
  Plus,
  Trash2,
  ShieldCheck,
  AlertTriangle,
} from 'lucide-react'
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
      toast.error('Dê um nome ao token — algo como"meu notebook".')
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
      toast.success(`Token"${tokenName}" revogado.`)
    })
  }

  return (
    <div className="space-y-4">
      {freshToken && (
        <div className="border-up bg-up/30 space-y-3 rounded-[var(--radius-inner)] border p-5">
          <div className="text-up-ink flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 shrink-0" />
            <h3 className="text-sm font-semibold">
              Token criado — copie agora
            </h3>
          </div>
          <p className="text-muted text-sm">
            Este valor não é recuperável. O Supremo guarda apenas o hash; se
            você perder o token, gere outro.
          </p>
          <div className="relative">
            <pre className="bg-surface overflow-x-auto rounded-[var(--radius-control)] p-3 pr-12 font-mono text-xs">
              {freshToken}
            </pre>
            <CopyButton
              value={freshToken}
              className="absolute top-2.5 right-2.5"
            />
          </div>
          <div className="relative">
            <p className="text-muted mb-1.5 text-xs font-medium">
              Conecte de qualquer máquina:
            </p>
            <pre className="bg-surface overflow-x-auto rounded-[var(--radius-control)] p-3 pr-12 font-mono text-xs">
              {`claude mcp add --transport http supremo ${mcpUrl} --header"Authorization: Bearer ${freshToken}"`}
            </pre>
            <CopyButton
              value={`claude mcp add --transport http supremo ${mcpUrl} --header"Authorization: Bearer ${freshToken}"`}
              className="absolute top-8 right-2.5"
            />
          </div>
          <button
            onClick={() => setFreshToken(null)}
            className="text-muted hover:text-ink text-xs font-medium transition-colors"
          >
            Já copiei, pode esconder
          </button>
        </div>
      )}

      <form onSubmit={handleCreate} className="flex flex-col gap-2 sm:flex-row">
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Nome do token — ex: notebook do trabalho"
          maxLength={60}
          className="bg-surface focus-visible:ring-line-strong h-10 flex-1 rounded-[var(--radius-control)] px-3 text-sm transition-shadow outline-none focus-visible:ring-2"
        />
        <button
          type="submit"
          disabled={isPending}
          className="bg-accent text-accent-ink hover:bg-accent/90 inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-[var(--radius-control)] px-4 text-sm font-semibold transition-colors disabled:opacity-50"
        >
          <Plus className="h-4 w-4" />
          Gerar token
        </button>
      </form>

      {tokens.length === 0 ? (
        <div className="rounded-[var(--radius-inner)] border-dashed p-6 text-center">
          <KeyRound className="text-muted mx-auto mb-2 h-6 w-6" />
          <p className="text-muted text-sm">
            Nenhum token ainda. Gere um para conectar o seu agente de qualquer
            computador.
          </p>
        </div>
      ) : (
        <ul className="overflow-hidden rounded-[var(--radius-inner)]">
          {tokens.map((token) => {
            const expired =
              token.expires_at !== null &&
              new Date(token.expires_at) < new Date()

            return (
              <li
                key={token.id}
                className="bg-surface flex items-center gap-3 p-3.5"
              >
                <KeyRound className="text-muted h-4 w-4 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-medium">
                      {token.name}
                    </span>
                    <code className="text-muted bg-sunken rounded px-1.5 py-0.5 font-mono text-[11px]">
                      {token.token_prefix}…
                    </code>
                    {expired && (
                      <span className="inline-flex items-center gap-1 text-[10px] font-semibold tracking-wide text-amber-600 uppercase">
                        <AlertTriangle className="h-3 w-3" />
                        expirado
                      </span>
                    )}
                  </div>
                  <p className="text-muted mt-0.5 text-xs">
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
                  title={`Revogar"${token.name}"`}
                  className="text-muted hover:bg-down hover:text-down-ink shrink-0 rounded-[var(--radius-control)] p-2 transition-colors disabled:opacity-50"
                >
                  <Trash2 className="h-4 w-4" />
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
