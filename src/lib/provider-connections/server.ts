import 'server-only'
import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { getProject } from '../projects/repository'
import { credentialStore } from '../credentials/store'
import { decryptCredential } from '../credentials/crypto'
import { authorizeProjectOperation } from '../backend-operations/server'
import { integrationConnectionInputSchema, integrationConnectionSchema, IntegrationError, type IntegrationConnection, type IntegrationConnectionInput } from '../integrations/contract'
import { inspectProviderIdentity } from '../integrations/providers'
import { protectedProviderRequest } from '../integrations/transport'
import { readOAuthAccessToken, revokeOAuthConnection } from './oauth-server'

export interface IntegrationAuthority { client: SupabaseClient; ownerId: string; projectId: string; deviceId?: string; ownerSession?: true; verifyIdentity(): Promise<string> }
const fields = 'id,user_id,project_id,credential_id,provider,environment,account_ref,account_identity_verified,scope,revoked_at,created_at'
const rowSchema = z.object({ id: z.uuid(), user_id: z.uuid(), project_id: z.uuid(), credential_id: z.uuid().nullable(), provider: z.string(), environment: z.string(), account_ref: z.string(), account_identity_verified: z.boolean(), scope: z.record(z.string(), z.unknown()), revoked_at: z.string().nullable(), created_at: z.string() })
function connectionView(raw: unknown): IntegrationConnection {
  const row = rowSchema.parse(raw)
  return integrationConnectionSchema.parse({ ...row.scope, id: row.id, ownerId: row.user_id, projectId: row.project_id, credentialId: row.credential_id,
    provider: row.provider, environment: row.environment, accountRef: row.account_ref, accountIdentityVerified: row.account_identity_verified,
    revokedAt: row.revoked_at, createdAt: row.created_at })
}
export async function verifyIntegrationOwner(authority: IntegrationAuthority): Promise<void> {
  z.uuid().parse(authority.ownerId); z.uuid().parse(authority.projectId)
  if (await authority.verifyIdentity() !== authority.ownerId) throw new IntegrationError('Identidade não autorizada.', 'forbidden')
  await getProject(authority.ownerId, authority.projectId)
}
export async function readProviderConnection(authority: IntegrationAuthority, id: string): Promise<IntegrationConnection> {
  await verifyIntegrationOwner(authority)
  const result = await authority.client.from('provider_connections').select(fields).eq('id', z.uuid().parse(id)).eq('user_id', authority.ownerId).eq('project_id', authority.projectId).maybeSingle()
  if (result.error || !result.data) throw new IntegrationError('Conexão não encontrada neste projeto ou serviço indisponível.', 'unavailable')
  return connectionView(result.data)
}
export async function connectionCredential(authority: IntegrationAuthority, connection: IntegrationConnection): Promise<string> {
  await verifyIntegrationOwner(authority)
  if (connection.revokedAt || connection.ownerId !== authority.ownerId || connection.projectId !== authority.projectId) throw new IntegrationError('Conexão revogada ou credencial indisponível.', 'forbidden')
  if (connection.oauth && !connection.credentialId) return readOAuthAccessToken(authority, connection.id)
  if (!connection.credentialId) throw new IntegrationError('Credencial removida.', 'forbidden')
  await authorizeProjectOperation({ ...authority, environment: connection.environment }, 'credentials.use', { resource: connection.credentialId })
  const port = credentialStore(authority.client, authority.ownerId, authority.projectId)
  await port.authorize()
  const record = await port.find(connection.credentialId)
  if (!record || record.environment !== connection.environment) throw new IntegrationError('Credencial removida ou pertencente a outro ambiente.', 'forbidden')
  return decryptCredential(record.encryptedValue, { id: record.id, userId: record.userId, projectId: record.projectId, environment: record.environment })
}
/** Called by the authenticated owner form, never by an arbitrary host/URL request. */
export async function createProviderConnection(authority: IntegrationAuthority, raw: IntegrationConnectionInput): Promise<IntegrationConnection> {
  const input = integrationConnectionInputSchema.parse(raw)
  if (input.projectId !== authority.projectId) throw new IntegrationError('Projeto divergente.', 'forbidden')
  await verifyIntegrationOwner(authority)
  await authorizeProjectOperation({ ...authority, environment: input.environment }, 'integrations.configure')
  const provisional: IntegrationConnection = { ...input, id: randomUUID(), ownerId: authority.ownerId, accountRef: 'pending', accountIdentityVerified: false, revokedAt: null, createdAt: new Date().toISOString() }
  const credential = await connectionCredential(authority, provisional)
  const identity = await inspectProviderIdentity(input.provider, credential, async request => {
    await verifyIntegrationOwner(authority)
    await authorizeProjectOperation({ ...authority, environment: input.environment }, 'integrations.configure')
    await connectionCredential(authority, provisional)
    return protectedProviderRequest(request)
  }, input.credentialId, input.contract)
  await verifyIntegrationOwner(authority)
  const connection = { ...provisional, ...identity }
  const audit = await authority.client.from('audit_logs').insert({ user_id: authority.ownerId, resource_type: 'project', resource_id: authority.projectId,
    action: 'integration.connection_create', metadata: { connectionId: connection.id, credentialId: connection.credentialId, provider: connection.provider, environment: connection.environment, accountRef: connection.accountRef }, ip_address: null })
  if (audit.error) throw new IntegrationError('Não foi possível registrar a autorização da conexão.', 'unavailable')
  const result = await authority.client.from('provider_connections').insert({ id: connection.id, user_id: authority.ownerId, project_id: authority.projectId,
    credential_id: input.credentialId, provider: input.provider, environment: input.environment, account_ref: identity.accountRef, account_identity_verified: identity.accountIdentityVerified,
    scope: { allowedSenders: input.allowedSenders, allowedRecipients: input.allowedRecipients, allowedRepositories: input.allowedRepositories, ...(input.contract ? { contract: input.contract } : {}) } }).select(fields).single()
  if (result.error) throw new IntegrationError('Não foi possível salvar a conexão. Confira a migration 034 do motor.', 'unavailable')
  return connectionView(result.data)
}
export async function listProviderConnections(authority: IntegrationAuthority): Promise<IntegrationConnection[]> {
  await verifyIntegrationOwner(authority)
  const result = await authority.client.from('provider_connections').select(fields).eq('user_id', authority.ownerId).eq('project_id', authority.projectId).order('created_at', { ascending: false }).limit(100)
  if (result.error) throw new IntegrationError('Conexões indisponíveis. Confira a migration 034 do motor.', 'unavailable')
  return (result.data ?? []).map(connectionView)
}
export async function revokeProviderConnection(authority: IntegrationAuthority, id: string): Promise<void> {
  const connection = await readProviderConnection(authority, id)
  await authorizeProjectOperation({ ...authority, environment: connection.environment }, 'integrations.configure', { resource: connection.id })
  const audit = await authority.client.from('audit_logs').insert({ user_id: authority.ownerId, action: 'integration.connection_revoke', resource_type: 'project', resource_id: authority.projectId, metadata: { connectionId: connection.id, provider: connection.provider }, ip_address: null })
  if (audit.error) throw new IntegrationError('Não foi possível registrar a desvinculação.', 'unavailable')
  if (connection.oauth) { await revokeOAuthConnection(authority, connection.id); return }
  const result = await authority.client.from('provider_connections').update({ revoked_at: new Date().toISOString() }).eq('id', connection.id).eq('user_id', authority.ownerId).eq('project_id', authority.projectId)
  if (result.error) throw new IntegrationError('Não foi possível revogar a conexão.', 'unavailable')
}
