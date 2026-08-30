'use server'

import { requireUser } from '@/lib/auth'
import { connectGithubAccount, connectSupabaseAccount } from './accounts'
import { startVercelOAuth } from './vercel'

/**
 * Ações sem argumento para os botões do passo a passo.
 *
 * Existem para o formulário poder chamá-las direto: passando a ação original
 * em `action={}`, o React entregaria o FormData como primeiro parâmetro — que
 * ali é o projectId.
 *
 * Cada uma confere a sessão antes de delegar. As ações finais já fazem isso,
 * mas Server Action é endpoint POST público e a verificação precisa estar
 * visível em cada porta de entrada, não só na última.
 */

export async function connectGithubFromOnboarding(): Promise<void> {
  await requireUser()
  await connectGithubAccount()
}

export async function connectSupabaseFromOnboarding(): Promise<void> {
  await requireUser()
  await connectSupabaseAccount()
}

export async function connectVercelFromOnboarding(): Promise<void> {
  await requireUser()
  await startVercelOAuth()
}
