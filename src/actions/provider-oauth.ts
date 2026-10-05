'use server'

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { requireProjectOwner, requireUser } from '@/lib/auth'
import { createServiceClient } from '@/lib/supabase/admin'
import { oauthConfigurationSchema, OAuthError } from '@/lib/provider-connections/oauth-contract'
import { beginOAuthConnection, revokeOAuthConnection } from '@/lib/provider-connections/oauth-server'

async function authority(projectId: string) {
  const { user } = await requireProjectOwner(projectId, 'id,user_id')
  return { client: createServiceClient(), ownerId: user.id, projectId, ownerSession:true as const, verifyIdentity: async () => (await requireUser()).user.id }
}
/** Configuration is approved by the authenticated owner through a CSRF-protected Server Action. */
export async function connectProjectOAuth(raw: unknown) {
  try {
    const input = z.object({ projectId: z.uuid(), configuration: oauthConfigurationSchema }).strict().parse(raw)
    return { ok: true as const, ...await beginOAuthConnection(await authority(input.projectId), input.configuration) }
  } catch (error) {
    return { ok: false as const, error: error instanceof OAuthError ? error.message : 'Não foi possível iniciar a autorização. Confira o projeto e as permissões escolhidas.' }
  }
}
/** Local revocation immediately prevents token use, including an in-flight refresh. */
export async function disconnectProjectOAuth(raw: unknown) {
  try {
    const input = z.object({ projectId: z.uuid(), connectionId: z.uuid() }).strict().parse(raw)
    const result = await revokeOAuthConnection(await authority(input.projectId), input.connectionId)
    revalidatePath(`/projects/${input.projectId}`)
    return { ok: true as const, ...result }
  } catch (error) {
    return { ok: false as const, error: error instanceof OAuthError ? error.message : 'Não foi possível confirmar a desconexão da conta.' }
  }
}
