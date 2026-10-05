import 'server-only'
import { z } from 'zod'
import { requireUser } from '../auth'
import { getProject } from '../projects/repository'
import { assertSamePolicy } from '../backend-operations/policy'
import { authorizeProjectOperation } from '../backend-operations/server'
import { credentialStore } from '../credentials/store'
import { decryptCredential, encryptCredential } from '../credentials/crypto'
import { protectedJsonRequest } from '../integrations/transport'
import type { IntegrationAuthority } from './server'
import { OAuthError, oauthConfigurationSchema, type OAuthCallback, type OAuthConfiguration } from './oauth-contract'
import { oauthStore } from './oauth-store'
import { oauthProvider } from './oauth-provider'
import { beginOAuth, completeOAuth, oauthAccessToken, revokeOAuth, type OAuthPort } from './oauth-service'

function port(authority: IntegrationAuthority, mode: 'configure' | 'use', connectionId?: string): OAuthPort {
  const authorize: OAuthPort['authorize'] = async (environment, capability, resource) => {
    if (mode === 'configure') {
      // Independent cookie-backed owner proof. An agent/device assertion or text
      // describing consent cannot approve endpoints, client or account binding.
      if ((await requireUser()).user.id !== authority.ownerId) throw new OAuthError('Somente o dono autenticado pode conectar uma conta OAuth.', 403)
    }
    return authorizeProjectOperation({ ...authority, environment }, capability, resource ? { resource } : {})
  }
  return {
    scope: { ownerId: z.uuid().parse(authority.ownerId), projectId: z.uuid().parse(authority.projectId) },
    store: oauthStore(authority.client, authority.ownerId, authority.projectId), authorize,
    seal(value, scope) { return encryptCredential(value, { id: scope.id, userId: scope.ownerId, projectId: scope.projectId, environment: scope.environment }) },
    open(value, scope) { return decryptCredential(value, { id: scope.id, userId: scope.ownerId, projectId: scope.projectId, environment: scope.environment }) },
    provider: oauthProvider(async (request, config) => {
      await authorize(config.environment, mode === 'configure' ? 'integrations.configure' : 'credentials.use', connectionId)
      return protectedJsonRequest(request)
    }, async config => {
      if (!config.clientSecretId) throw new OAuthError('Credencial do cliente OAuth ausente.', 403)
      await authorize(config.environment, 'credentials.use', config.clientSecretId)
      const store = credentialStore(authority.client, authority.ownerId, authority.projectId)
      await store.authorize()
      const record = await store.find(config.clientSecretId)
      if (!record || record.environment !== config.environment) throw new OAuthError('Credencial OAuth pertence a outro ambiente ou foi removida.', 403)
      return decryptCredential(record.encryptedValue, { id: record.id, userId: record.userId, projectId: record.projectId, environment: record.environment })
    }),
  }
}
export function oauthCallbackUrl(): string {
  const url = new URL(process.env.NEXT_PUBLIC_APP_URL ?? '')
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new OAuthError('Origem do Supremo inválida para OAuth.', 503)
  return new URL('/auth/provider/callback', url).toString()
}
/** Owner-session Server Action only. Returns a consent URL, never a token. */
export async function beginOAuthConnection(authority: IntegrationAuthority, input: OAuthConfiguration): Promise<{ authorizationUrl: string; expiresAt: string }> {
  return beginOAuth(port(authority, 'configure'), input, oauthCallbackUrl())
}
/** Callback Route Handler with the same authenticated owner session. */
export async function completeOAuthConnection(authority: IntegrationAuthority, input: OAuthCallback): Promise<{ connectionId: string; accountRef: string; verified: true }> {
  if ((await requireUser()).user.id !== authority.ownerId || await authority.verifyIdentity() !== authority.ownerId) throw new OAuthError('Sessão OAuth divergente.', 403)
  return completeOAuth(port(authority, 'configure'), input)
}
/** Server adapter only; never return this value from an API or Server Action. */
export async function readOAuthAccessToken(authority: IntegrationAuthority, connectionId: string): Promise<string> {
  return oauthAccessToken(port(authority, 'use', connectionId), connectionId)
}
export async function revokeOAuthConnection(authority: IntegrationAuthority, connectionId: string): Promise<{ revoked: true; verified: true }> {
  return revokeOAuth(port(authority, 'configure'), connectionId)
}

/** Prepare every credential dependency before the integration ledger claims an
 * effect. Reads metadata only; no token/client secret is opened or refreshed. */
export async function authorizeOAuthCredentialUse(authority: IntegrationAuthority, connectionId: string): Promise<void> {
  z.uuid().parse(connectionId)
  if (await authority.verifyIdentity() !== authority.ownerId) throw new OAuthError('Identidade não autorizada.', 403)
  await getProject(authority.ownerId, authority.projectId)
  const linked = await authority.client.from('provider_connections').select('id').eq('id', connectionId).eq('user_id', authority.ownerId).eq('project_id', authority.projectId).is('revoked_at', null).maybeSingle()
  if (linked.error || !linked.data) throw new OAuthError('Conexão OAuth removida ou revogada.', 403)
  const found = await authority.client.from('project_oauth_credentials').select('config,status').eq('connection_id', connectionId).eq('user_id', authority.ownerId).eq('project_id', authority.projectId).maybeSingle()
  if (found.error || !found.data || !['active','refreshing'].includes(String(found.data.status))) throw new OAuthError('Conexão OAuth indisponível. Reconecte a conta.', 409)
  const config = oauthConfigurationSchema.parse(found.data.config)
  const binding = await authorizeProjectOperation({ ...authority, environment: config.environment }, 'credentials.use', { resource: connectionId })
  if (config.clientSecretId) assertSamePolicy(binding, await authorizeProjectOperation({ ...authority, environment: config.environment }, 'credentials.use', { resource: config.clientSecretId }))
  if (await authority.verifyIdentity() !== authority.ownerId) throw new OAuthError('Identidade revogada durante a preparação.', 403)
}
