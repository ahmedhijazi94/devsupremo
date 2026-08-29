import { createClient } from '@/lib/supabase/server'
import type { SupabaseClient, User } from '@supabase/supabase-js'

/**
 * Verificação de sessão para Server Actions e Route Handlers.
 *
 * Server Action é endpoint POST público: qualquer um pode invocá-la. O RLS
 * protege os dados, mas depender só dele deixa a checagem a uma migration
 * errada de distância. Estas funções são a segunda camada.
 */

export class UnauthorizedError extends Error {
  constructor(message = 'Não autorizado.') {
    super(message)
    this.name = 'UnauthorizedError'
  }
}

export class ForbiddenError extends Error {
  constructor(message = 'Acesso negado.') {
    super(message)
    this.name = 'ForbiddenError'
  }
}

export interface AuthContext {
  user: User
  supabase: SupabaseClient
}

/** Exige sessão válida. Lança se não houver. */
export async function requireUser(): Promise<AuthContext> {
  const supabase = await createClient()
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser()

  if (error || !user) throw new UnauthorizedError()
  return { user, supabase }
}

export interface OwnedProject {
  user: User
  supabase: SupabaseClient
  project: Record<string, unknown> & { id: string; user_id: string }
}

/**
 * Exige sessão E propriedade do projeto. O filtro por `user_id` é explícito
 * em vez de delegado ao RLS.
 */
export async function requireProjectOwner(
  projectId: string,
  columns = '*'
): Promise<OwnedProject> {
  const { user, supabase } = await requireUser()

  const { data: project, error } = await supabase
    .from('projects')
    .select(columns)
    .eq('id', projectId)
    .eq('user_id', user.id)
    .maybeSingle()

  if (error) throw new Error(`Erro ao buscar projeto: ${error.message}`)
  if (!project) throw new ForbiddenError('Projeto não encontrado.')

  return {
    user,
    supabase,
    project: project as unknown as OwnedProject['project'],
  }
}

/** Converte as exceções acima na mensagem que a UI mostra. */
export function toActionError(error: unknown): string {
  if (error instanceof UnauthorizedError) return error.message
  if (error instanceof ForbiddenError) return error.message
  if (error instanceof Error) return error.message
  return 'Erro inesperado.'
}
