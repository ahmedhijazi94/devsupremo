'use client'

import { createClient } from '@/lib/supabase/client'
import { GitBranch } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'

export function LoginForm() {
  const [loading, setLoading] = useState<'github' | 'google' | null>(null)
  const supabase = createClient()

  async function handleOAuth(provider: 'github' | 'google') {
    setLoading(provider)
    const { error } = await supabase.auth.signInWithOAuth({
      provider,
      options: {
        redirectTo: `${window.location.origin}/auth/callback`,
        ...(provider === 'github' && { scopes: 'read:user user:email' }),
      },
    })
    if (error) {
      toast.error('Erro ao fazer login. Tente novamente.')
      setLoading(null)
    }
  }

  return (
    <div className="space-y-3">
      <button
        onClick={() => handleOAuth('github')}
        disabled={loading !== null}
        className="w-full inline-flex items-center justify-center gap-3 rounded-lg border border-line bg-surface px-4 py-3 font-semibold hover:bg-sunken transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <GitBranch className="w-5 h-5" />
        {loading === 'github' ? 'Redirecionando...' : 'Continuar com GitHub'}
      </button>

      <button
        onClick={() => handleOAuth('google')}
        disabled={loading !== null}
        className="w-full inline-flex items-center justify-center gap-3 rounded-lg border border-line bg-surface px-4 py-3 font-semibold hover:bg-sunken transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <svg className="w-5 h-5" viewBox="0 0 24 24">
          <path
            d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
            fill="#4285F4"
          />
          <path
            d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
            fill="#34A853"
          />
          <path
            d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
            fill="#FBBC05"
          />
          <path
            d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
            fill="#EA4335"
          />
        </svg>
        {loading === 'google' ? 'Redirecionando...' : 'Continuar com Google'}
      </button>

      <p className="text-center text-xs text-muted pt-2">
        Ao entrar, você concorda com os termos de uso e política de privacidade.
      </p>
    </div>
  )
}
