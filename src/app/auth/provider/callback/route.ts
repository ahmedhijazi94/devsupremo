import { requireProjectOwner, requireUser } from '@/lib/auth'
import { createServiceClient } from '@/lib/supabase/admin'
import { oauthCallbackProjectId, oauthCallbackSchema } from '@/lib/provider-connections/oauth-contract'
import { completeOAuthConnection, oauthCallbackUrl } from '@/lib/provider-connections/oauth-server'

export const runtime = 'nodejs'

export async function GET(request: Request): Promise<Response> {
  let destination = '/projects?oauth=not-confirmed'
  try {
    const params = new URL(request.url).searchParams
    if (params.getAll('state').length !== 1 || params.getAll('code').length !== 1 || params.getAll('iss').length > 1 || params.has('error')) throw new Error('Invalid callback')
    const issuer = params.get('iss')
    const input = oauthCallbackSchema.parse({ state: params.get('state'), code: params.get('code'), ...(issuer ? { issuer } : {}) })
    const projectId = oauthCallbackProjectId(input.state)
    // State is a locator only. Cookie authentication and ownership are required
    // before the privileged store can consume it or exchange the code.
    const { user } = await requireProjectOwner(projectId, 'id,user_id')
    await completeOAuthConnection({ client: createServiceClient(), ownerId: user.id, projectId, ownerSession:true, verifyIdentity: async () => (await requireUser()).user.id }, input)
    destination = `/projects/${projectId}?oauth=connected`
  } catch {
    // Never reflect provider errors, code, state or token payloads into the UI.
    destination = '/projects?oauth=not-confirmed'
  }
  try {
    return new Response(null, { status: 303, headers: { Location: new URL(destination, oauthCallbackUrl()).toString(), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } })
  } catch {
    return new Response('Retorno OAuth indisponível. Confira o endereço configurado do Supremo.', { status: 503, headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } })
  }
}
