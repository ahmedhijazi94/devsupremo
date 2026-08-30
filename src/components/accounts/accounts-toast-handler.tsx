'use client'

import { useEffect } from 'react'
import { toast } from 'sonner'
import { useRouter } from 'next/navigation'

const successMessages: Record<string, string> = {
  github_connected: 'Conta GitHub conectada.',
  supabase_connected: 'Conta Supabase conectada.',
  vercel_connected: 'Conta Vercel conectada. Projetos novos já nascem com preview.',
}

const errorMessages: Record<string, string> = {
  github_denied: 'Autorização do GitHub negada.',
  invalid_state: 'Erro de segurança (state inválido). Tente novamente.',
  token_exchange_failed: 'Erro ao trocar código GitHub. Tente novamente.',
  no_access_token: 'GitHub não retornou um token. Tente novamente.',
  save_failed: 'Erro ao salvar conta. Tente novamente.',
  invalid_callback: 'Callback inválido.',
  vercel_denied: 'Autorização da Vercel negada.',
  vercel_exchange_failed: 'A Vercel recusou a troca do código. Tente de novo.',
  vercel_oauth_unavailable:
    'A integração da Vercel não está configurada neste ambiente.',
}

interface AccountsToastHandlerProps {
  success: string | undefined
  error: string | undefined
}

export function AccountsToastHandler({ success, error }: AccountsToastHandlerProps) {
  const router = useRouter()

  useEffect(() => {
    if (success) {
      const message = successMessages[success] ?? 'Operação bem-sucedida!'
      toast.success(message)
      // Limpar o query param da URL
      router.replace('/accounts')
    }
    if (error) {
      const message = errorMessages[error] ?? 'Ocorreu um erro.'
      toast.error(message)
      router.replace('/accounts')
    }
  }, [success, error, router])

  return null
}
