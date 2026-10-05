import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { oauthConfigurationSchema, OAuthError } from './oauth-contract'
import type { OAuthConnection, OAuthState, OAuthStore } from './oauth-service'

const base = { user_id: z.uuid(), project_id: z.uuid(), environment: z.enum(['development', 'production']), config: oauthConfigurationSchema }
const stateSchema = z.object({ ...base, id: z.uuid(), state_hash: z.string(), redirect_uri: z.string(), verifier_cipher: z.string(), policy_id: z.uuid(), policy_revision: z.uuid(), expires_at: z.string() })
const connectionSchema = z.object({ ...base, connection_id: z.uuid(), token_cipher: z.string(), version: z.number().int().positive(), status: z.enum(['active', 'refreshing', 'uncertain', 'revoked']), claim_token: z.uuid().nullable() })
function state(raw: unknown): OAuthState {
  const row = stateSchema.parse(raw)
  return { id: row.id, ownerId: row.user_id, projectId: row.project_id, environment: row.environment, config: row.config, stateHash: row.state_hash, redirectUri: row.redirect_uri, verifierCipher: row.verifier_cipher, policyId: row.policy_id, policyRevision: row.policy_revision, expiresAt: Date.parse(row.expires_at) }
}
function connection(raw: unknown): OAuthConnection {
  const row = connectionSchema.parse(raw)
  return { id: row.connection_id, ownerId: row.user_id, projectId: row.project_id, environment: row.environment, config: row.config, tokenCipher: row.token_cipher, version: row.version, state: row.status, claim: row.claim_token }
}
export function oauthStore(client: SupabaseClient, ownerId: string, projectId: string): OAuthStore {
  const scoped = { p_owner: ownerId, p_project: projectId }
  async function rpc(name: string, args: Record<string, string | number>): Promise<unknown> {
    const result = await client.rpc(name, { ...scoped, ...args })
    if (result.error) throw new OAuthError('Não foi possível persistir o estado OAuth. Resultado não confirmado.', 503)
    return result.data
  }
  async function confirmed(name: string, args: Record<string, string | number>): Promise<void> {
    if (await rpc(name, args) !== true) throw new OAuthError('Estado OAuth mudou; resultado não confirmado.', 409)
  }
  return {
    async createState(value) {
      if (value.ownerId !== ownerId || value.projectId !== projectId) throw new OAuthError('Escopo OAuth divergente.', 403)
      const result = await client.from('project_oauth_states').insert({ id: value.id, user_id: ownerId, project_id: projectId, environment: value.environment, config: value.config, state_hash: value.stateHash, redirect_uri: value.redirectUri, verifier_cipher: value.verifierCipher, policy_id: value.policyId, policy_revision: value.policyRevision, expires_at: new Date(value.expiresAt).toISOString() })
      if (result.error) throw new OAuthError('Não foi possível iniciar OAuth. Confira a migration 036.', 503)
    },
    async claimState(stateHash, claim) {
      const raw = await rpc('claim_project_oauth_state', { p_hash: stateHash, p_claim: claim })
      return raw ? state(raw) : null
    },
    async finishState(value, claim, tokenCipher) { await confirmed('finish_project_oauth_state', { p_id: value.id, p_claim: claim, p_cipher: tokenCipher }) },
    async failState(id, claim) {
      const result = await client.from('project_oauth_states').update({ status: 'uncertain', verifier_cipher: '' }).eq('id', id).eq('user_id', ownerId).eq('project_id', projectId).eq('status', 'exchanging').eq('claim_token', claim)
      if (result.error) throw new OAuthError('Persistência OAuth indisponível.', 503)
    },
    async readConnection(id) {
      const linked = await client.from('provider_connections').select('id').eq('id', id).eq('user_id', ownerId).eq('project_id', projectId).is('revoked_at', null).maybeSingle()
      if (linked.error || !linked.data) return null
      const result = await client.from('project_oauth_credentials').select('*').eq('connection_id', id).eq('user_id', ownerId).eq('project_id', projectId).maybeSingle()
      if (result.error) throw new OAuthError('Conexão OAuth indisponível.', 503)
      return result.data ? connection(result.data) : null
    },
    async claimRefresh(id, version, claim) { return await rpc('claim_project_oauth_refresh', { p_id: id, p_version: version, p_claim: claim }) === true },
    async finishRefresh(id, version, claim, tokenCipher) { await confirmed('finish_project_oauth_refresh', { p_id: id, p_version: version, p_claim: claim, p_cipher: tokenCipher }) },
    async failRefresh(id, version, claim) {
      const result = await client.from('project_oauth_credentials').update({ status: 'uncertain' }).eq('connection_id', id).eq('user_id', ownerId).eq('project_id', projectId).eq('version', version).eq('status', 'refreshing').eq('claim_token', claim)
      if (result.error) throw new OAuthError('Persistência OAuth indisponível.', 503)
    },
    async revoke(id) { await confirmed('revoke_project_oauth_connection', { p_id: id }) },
  }
}
