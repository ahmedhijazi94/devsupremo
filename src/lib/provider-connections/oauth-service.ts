import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { selectedField } from '../integrations/generic-contract'
import { oauthCallbackSchema, oauthConfigurationSchema, OAuthError, oauthTokensSchema, type OAuthCallback, type OAuthConfiguration, type OAuthTokens } from './oauth-contract'

export interface OAuthScope { ownerId: string; projectId: string; environment: 'development' | 'production' }
export interface OAuthState extends OAuthScope {
  id: string; stateHash: string; config: OAuthConfiguration; redirectUri: string;
  verifierCipher: string; policyId: string; policyRevision: string; expiresAt: number
}
export interface OAuthConnection extends OAuthScope {
  id: string; config: OAuthConfiguration; tokenCipher: string; version: number;
  state: 'active' | 'refreshing' | 'uncertain' | 'revoked'; claim: string | null
}
export interface OAuthStore {
  createState(state: OAuthState): Promise<void>
  claimState(stateHash: string, claim: string): Promise<OAuthState | null>
  finishState(state: OAuthState, claim: string, tokenCipher: string): Promise<void>
  failState(id: string, claim: string): Promise<void>
  readConnection(id: string): Promise<OAuthConnection | null>
  claimRefresh(id: string, version: number, claim: string): Promise<boolean>
  finishRefresh(id: string, version: number, claim: string, tokenCipher: string): Promise<void>
  failRefresh(id: string, version: number, claim: string): Promise<void>
  revoke(id: string): Promise<void>
}
export interface OAuthProvider {
  exchange(config: OAuthConfiguration, input: { code: string; verifier: string; redirectUri: string }): Promise<unknown>
  refresh(config: OAuthConfiguration, refreshToken: string): Promise<unknown>
  identity(config: OAuthConfiguration, accessToken: string): Promise<unknown>
}
export interface OAuthPort {
  scope: Omit<OAuthScope, 'environment'>; store: OAuthStore; provider: OAuthProvider;
  authorize(environment: OAuthScope['environment'], capability: 'integrations.configure' | 'credentials.use', resource?: string): Promise<{ policyId: string; revision: string }>
  seal(value: string, scope: OAuthScope & { id: string }): string
  open(value: string, scope: OAuthScope & { id: string }): string
  now?(): number
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const tokenResponseSchema = z.object({ access_token: z.string().min(1).max(6000).regex(/^[^\u0000-\u0020\u007f]+$/), token_type: z.string().regex(/^bearer$/i), refresh_token: z.string().min(1).max(6000).regex(/^[^\u0000-\u0020\u007f]+$/).optional(), expires_in: z.number().int().min(1).max(31_536_000).optional(), scope: z.string().max(4000).optional() })
function tokens(raw: unknown, config: OAuthConfiguration, now: number, previous?: OAuthTokens): OAuthTokens {
  const parsed = tokenResponseSchema.safeParse(raw)
  if (!parsed.success) throw new OAuthError('Resposta OAuth inválida; conexão não confirmada.')
  const result = parsed.data
  if (previous?.expiresAt !== undefined && previous.expiresAt !== null && result.expires_in === undefined) throw new OAuthError('Renovação sem prazo confirmado; reconecte a conta.')
  const scopes = result.scope === undefined ? (previous?.scopes ?? config.scopes) : result.scope.split(' ').filter(Boolean)
  if (new Set(scopes).size !== scopes.length || scopes.length !== config.scopes.length || scopes.some(scope => !config.scopes.includes(scope))) throw new OAuthError('Os escopos retornados diferem da autorização aprovada.')
  return { accessToken: result.access_token, refreshToken: result.refresh_token ?? previous?.refreshToken ?? null, expiresAt: result.expires_in === undefined ? null : now + result.expires_in * 1000, scopes }
}
function bound(port: OAuthPort, value: OAuthScope): void {
  if (value.ownerId !== port.scope.ownerId || value.projectId !== port.scope.projectId) throw new OAuthError('Conexão OAuth pertence a outro projeto ou dono.', 403)
}
async function identity(port: OAuthPort, config: OAuthConfiguration, value: OAuthTokens): Promise<void> {
  const raw = await port.provider.identity(config, value.accessToken)
  const account = selectedField(raw, config.connector.identity.field)
  if ((typeof account !== 'string' && typeof account !== 'number') || String(account) !== config.connector.identity.account) throw new OAuthError('A conta autorizada difere da conta aprovada para o projeto.', 403)
}
function redirect(value: string): string {
  const url = new URL(value)
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) || url.username || url.password || url.search || url.hash) throw new OAuthError('URL de retorno OAuth inválida.')
  return url.toString()
}
export async function beginOAuth(port: OAuthPort, raw: OAuthConfiguration, redirectUri: string): Promise<{ authorizationUrl: string; expiresAt: string }> {
  const config = oauthConfigurationSchema.parse(raw)
  const policy = await port.authorize(config.environment, 'integrations.configure')
  const state = `${port.scope.projectId}.${randomBytes(32).toString('base64url')}`
  const verifier = randomBytes(32).toString('base64url')
  const record: OAuthState = { ...port.scope, environment: config.environment, id: randomUUID(), config, stateHash: hash(state), redirectUri: redirect(redirectUri), verifierCipher: '', policyId: policy.policyId, policyRevision: policy.revision, expiresAt: (port.now?.() ?? Date.now()) + 600_000 }
  record.verifierCipher = port.seal(verifier, record)
  await port.store.createState(record)
  const url = new URL(config.authorization.path, config.authorization.origin)
  url.search = new URLSearchParams({ response_type: 'code', client_id: config.clientId, redirect_uri: record.redirectUri, scope: config.scopes.join(' '), state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' }).toString()
  return { authorizationUrl: url.toString(), expiresAt: new Date(record.expiresAt).toISOString() }
}
export async function completeOAuth(port: OAuthPort, raw: OAuthCallback): Promise<{ connectionId: string; accountRef: string; verified: true }> {
  const input = oauthCallbackSchema.parse(raw), claim = randomUUID()
  const record = await port.store.claimState(hash(input.state), claim)
  if (!record) throw new OAuthError('Autorização OAuth expirada, já utilizada ou pertencente a outra sessão.')
  try {
    bound(port, record)
    if (record.expiresAt <= (port.now?.() ?? Date.now()) || (record.config.issuer !== undefined && input.issuer !== record.config.issuer) || (input.issuer !== undefined && input.issuer !== (record.config.issuer ?? record.config.authorization.origin))) throw new OAuthError('Emissor ou validade OAuth divergente.', 403)
    const policy = await port.authorize(record.environment, 'integrations.configure')
    if (policy.policyId !== record.policyId || policy.revision !== record.policyRevision) throw new OAuthError('A autorização do projeto mudou. Inicie uma nova conexão.')
    const result = tokens(await port.provider.exchange(record.config, { code: input.code, verifier: port.open(record.verifierCipher, record), redirectUri: record.redirectUri }), record.config, port.now?.() ?? Date.now())
    await identity(port, record.config, result)
    const current = await port.authorize(record.environment, 'integrations.configure')
    if (current.policyId !== policy.policyId || current.revision !== policy.revision) throw new OAuthError('A autorização do projeto mudou durante a conexão.')
    await port.store.finishState(record, claim, port.seal(JSON.stringify(result), record))
    return { connectionId: record.id, accountRef: record.config.connector.identity.account, verified: true }
  } catch {
    await port.store.failState(record.id, claim).catch(() => { throw new OAuthError('Resultado OAuth incerto; autorização consumida. Reconecte a conta.', 503) })
    throw new OAuthError('Conexão OAuth não confirmada; autorização consumida. Inicie novamente.', 409)
  }
}
/** SERVER ONLY: the returned credential must never enter action/API responses or logs. */
export async function oauthAccessToken(port: OAuthPort, id: string): Promise<string> {
  z.uuid().parse(id)
  const connection = await port.store.readConnection(id)
  if (!connection) throw new OAuthError('Conexão OAuth não encontrada.', 404)
  bound(port, connection)
  await port.authorize(connection.environment, 'credentials.use', id)
  if (connection.state !== 'active') {
    // The database changes an expired in-flight refresh to uncertain; it never
    // grants a second claim over a potentially rotated refresh token.
    if (connection.state === 'refreshing') await port.store.claimRefresh(id, connection.version, randomUUID())
    throw new OAuthError('Conexão OAuth revogada, em renovação ou com resultado incerto. Reconecte se necessário.')
  }
  const saved = oauthTokensSchema.parse(JSON.parse(port.open(connection.tokenCipher, connection)))
  if (saved.expiresAt === null || saved.expiresAt > (port.now?.() ?? Date.now()) + 60_000) return saved.accessToken
  if (!saved.refreshToken) throw new OAuthError('A autorização OAuth expirou e não oferece renovação. Reconecte a conta.')
  const claim = randomUUID()
  if (!await port.store.claimRefresh(id, connection.version, claim)) throw new OAuthError('Outra execução renovou ou está renovando a conexão. Resultado não repetido.')
  try {
    await port.authorize(connection.environment, 'credentials.use', id)
    const renewed = tokens(await port.provider.refresh(connection.config, saved.refreshToken), connection.config, port.now?.() ?? Date.now(), saved)
    await identity(port, connection.config, renewed)
    await port.authorize(connection.environment, 'credentials.use', id)
    await port.store.finishRefresh(id, connection.version, claim, port.seal(JSON.stringify(renewed), connection))
    return renewed.accessToken
  } catch {
    await port.store.failRefresh(id, connection.version, claim).catch(() => { throw new OAuthError('Renovação OAuth incerta; não repita o refresh. Reconecte a conta.', 503) })
    throw new OAuthError('Renovação OAuth incerta; token bloqueado até reconectar a conta.', 409)
  }
}
export async function revokeOAuth(port: OAuthPort, id: string): Promise<{ revoked: true; verified: true }> {
  const connection = await port.store.readConnection(z.uuid().parse(id))
  if (!connection) throw new OAuthError('Conexão OAuth não encontrada.', 404)
  bound(port, connection)
  await port.authorize(connection.environment, 'integrations.configure', id)
  await port.store.revoke(id)
  return { revoked: true, verified: true }
}
