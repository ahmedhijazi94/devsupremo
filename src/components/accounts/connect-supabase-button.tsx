'use client'

import { useState } from 'react'
import { Plus, KeyRound } from 'lucide-react'
import { connectSupabaseAccount } from '@/actions/accounts'
import { AddSupabaseModal } from './add-supabase-modal'

interface ConnectSupabaseButtonProps {
  /** Sem o app OAuth configurado, resta o token pessoal. */
  oauthAvailable: boolean
}

/**
 * Conexão da conta Supabase.
 *
 * O OAuth já existia no código mas a tela de contas só oferecia o token —
 * quem conectava por ali passava por um trabalho desnecessário.
 */
export function ConnectSupabaseButton({
  oauthAvailable,
}: ConnectSupabaseButtonProps) {
  const [showToken, setShowToken] = useState(false)

  if (!oauthAvailable) {
    return <AddSupabaseModal />
  }

  return (
    <div className="flex items-center gap-2">
      {showToken && <AddSupabaseModal />}

      <button
        onClick={() => setShowToken((value) => !value)}
        title="Usar token pessoal em vez de autorizar"
        className="text-muted hover:bg-sunken hover:text-ink rounded-[var(--radius-control)] p-2 transition-colors"
      >
        <KeyRound className="h-4 w-4" />
      </button>

      <form action={() => connectSupabaseAccount()}>
        <button
          type="submit"
          className="inline-flex h-9 items-center gap-2 rounded-[var(--radius-control)] bg-[#3ECF8E] px-3.5 text-sm font-medium text-black transition-opacity hover:opacity-90"
        >
          <Plus className="h-4 w-4" />
          Conectar Supabase
        </button>
      </form>
    </div>
  )
}
