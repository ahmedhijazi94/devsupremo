'use client'

import { useEffect } from 'react'
import { toast } from 'sonner'
import { useRouter } from 'next/navigation'

const successMessages: Record<string, string> = {
  github_connected: '✅ Conta GitHub conectada com sucesso!',
}

const errorMessages: Record<string, string> = {
  github_denied: 'Autorização do GitHub negada.',
  invalid_state: 'Erro de segurança (state inválido). Tente novamente.',
  token_exchange_failed: 'Erro ao trocar código GitHub. Tente novamente.',
  no_access_token: 'GitHub não retornou um token. Tente novamente.',
  save_failed: 'Erro ao salvar conta. Tente novamente.',
  invalid_callback: 'Callback inválido.',
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
