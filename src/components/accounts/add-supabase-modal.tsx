'use client'

import { useState, useTransition } from 'react'
import { Key, X, ExternalLink, Eye, EyeOff } from 'lucide-react'
import { addSupabaseAccount } from '@/actions/accounts'
import { toast } from 'sonner'

export function AddSupabaseModal({ projectId }: { projectId?: string }) {
  const [isOpen, setIsOpen] = useState(false)
  const [token, setToken] = useState('')
  const [showToken, setShowToken] = useState(false)
  const [isPending, startTransition] = useTransition()

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    startTransition(async () => {
      const result = await addSupabaseAccount({
        accessToken: token,
        projectId,
      })
      if (result.error) {
        toast.error(result.error)
        return
      }
      toast.success('Conta Supabase conectada com sucesso!')
      setToken('')
      setIsOpen(false)
    })
  }

  return (
    <>
      <button
        onClick={() => setIsOpen(true)}
        className="bg-sunken hover:bg-sunken inline-flex items-center gap-2 rounded-[var(--radius-control)] px-3 py-1.5 text-sm font-medium transition-colors"
      >
        <Key className="h-4 w-4" />
        Adicionar Access Token
      </button>

      {isOpen && (
        <div className="bg-ink/25 fixed inset-0 z-50 flex items-center justify-center p-4 backdrop-blur-sm">
          <div className="bg-surface w-full max-w-md space-y-5 rounded-2xl p-6 shadow-2xl">
            {/* Header */}
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">Conectar Supabase</h2>
              <button
                onClick={() => setIsOpen(false)}
                className="hover:bg-sunken text-muted rounded-[var(--radius-control)] p-1 transition-colors"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Instruções */}
            <div className="bg-sunken/50 space-y-2 rounded-[var(--radius-control)] p-4 text-sm">
              <p className="font-medium">Como obter seu Access Token:</p>
              <ol className="text-muted list-inside list-decimal space-y-1">
                <li>
                  Acesse{' '}
                  <a
                    href="https://supabase.com/dashboard/account/tokens"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-ink inline-flex items-center gap-1 underline"
                  >
                    supabase.com/dashboard/account/tokens
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </li>
                <li>
                  Clique em <strong>&quot;Generate new token&quot;</strong>
                </li>
                <li>Copie o token gerado e cole abaixo</li>
              </ol>
            </div>

            {/* Form */}
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">
                  Personal Access Token
                </label>
                <div className="relative">
                  <input
                    type={showToken ? 'text' : 'password'}
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    placeholder="sbp_..."
                    required
                    className="bg-sunken focus:ring-ink w-full rounded-[var(--radius-control)] px-3 py-2 pr-10 text-sm focus:ring-2 focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => setShowToken(!showToken)}
                    className="text-muted hover:text-ink absolute top-1/2 right-3 -translate-y-1/2"
                  >
                    {showToken ? (
                      <EyeOff className="h-4 w-4" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                  </button>
                </div>
                <p className="text-muted text-xs">
                  O token será criptografado com AES-256-GCM antes de ser salvo.
                </p>
              </div>

              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setIsOpen(false)}
                  className="hover:bg-sunken flex-1 rounded-[var(--radius-control)] px-4 py-2 text-sm font-medium transition-colors"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={isPending || !token.trim()}
                  className="bg-accent text-accent-ink hover:bg-accent/90 flex-1 rounded-[var(--radius-control)] px-4 py-2 text-sm font-semibold transition-colors disabled:opacity-50"
                >
                  {isPending ? 'Validando...' : 'Conectar'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  )
}
