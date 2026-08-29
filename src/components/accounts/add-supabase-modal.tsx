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
      const result = await addSupabaseAccount({ accessToken: token, projectId })
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
        className="inline-flex items-center gap-2 rounded-lg bg-secondary px-3 py-1.5 text-sm font-medium hover:bg-secondary/80 transition-colors"
      >
        <Key className="w-4 h-4" />
        Adicionar Access Token
      </button>

      {isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-2xl border bg-card p-6 shadow-2xl space-y-5">
            {/* Header */}
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">Conectar Supabase</h2>
              <button
                onClick={() => setIsOpen(false)}
                className="p-1 rounded-lg hover:bg-accent transition-colors text-muted-foreground"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Instruções */}
            <div className="rounded-lg bg-muted/50 border p-4 text-sm space-y-2">
              <p className="font-medium">Como obter seu Access Token:</p>
              <ol className="space-y-1 text-muted-foreground list-decimal list-inside">
                <li>
                  Acesse{' '}
                  <a
                    href="https://supabase.com/dashboard/account/tokens"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary underline inline-flex items-center gap-1"
                  >
                    supabase.com/dashboard/account/tokens
                    <ExternalLink className="w-3 h-3" />
                  </a>
                </li>
                <li>Clique em <strong>"Generate new token"</strong></li>
                <li>Copie o token gerado e cole abaixo</li>
              </ol>
            </div>

            {/* Form */}
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">Personal Access Token</label>
                <div className="relative">
                  <input
                    type={showToken ? 'text' : 'password'}
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    placeholder="sbp_..."
                    required
                    className="w-full rounded-lg border bg-background px-3 py-2 pr-10 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                  />
                  <button
                    type="button"
                    onClick={() => setShowToken(!showToken)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    {showToken ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
                <p className="text-xs text-muted-foreground">
                  O token será criptografado com AES-256-GCM antes de ser salvo.
                </p>
              </div>

              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setIsOpen(false)}
                  className="flex-1 rounded-lg border px-4 py-2 text-sm font-medium hover:bg-accent transition-colors"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={isPending || !token.trim()}
                  className="flex-1 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
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
