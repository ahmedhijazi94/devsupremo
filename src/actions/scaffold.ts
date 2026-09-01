'use server'

import { revalidatePath } from 'next/cache'
import { requireUser, toActionError } from '@/lib/auth'
import { provisionProject } from '@/lib/provisioning/provision'

/**
 * Action de provisionamento — wrapper fino. Resolve o usuário (sessão) e delega
 * ao core em `@/lib/provisioning/provision`, que contém a lógica real (state
 * machine idempotente). O mesmo core é usado pelo E2E script-driven, sem sessão.
 */
export async function scaffoldProject(
  projectId: string,
): Promise<{ error?: string; warnings?: string[] }> {
  try {
    const { user, supabase } = await requireUser()
    const result = await provisionProject({
      projectId,
      userId: user.id,
      supabase,
    })
    if (!result.error) revalidatePath('/', 'layout')
    return result
  } catch (error) {
    console.error('[scaffold] falhou:', error)
    const message = toActionError(error)
    // Best-effort: marca a falha na máquina de estados (não relança).
    try {
      const { user, supabase } = await requireUser()
      await supabase
        .from('projects')
        .update({ provisioning_state: 'failed', provisioning_error: message })
        .eq('id', projectId)
        .eq('user_id', user.id)
    } catch {
      // sem sessão / sem acesso: nada a marcar
    }
    return { error: message }
  }
}
