import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { encryptCredential, decryptCredential } from '../credentials/crypto'
import type { ProtectedJsonRequest } from '../integrations/transport'
import { oauthCallbackProjectId, oauthConfigurationSchema, type OAuthConfiguration } from './oauth-contract'
import { oauthProvider } from './oauth-provider'
import { beginOAuth, completeOAuth, oauthAccessToken, revokeOAuth, type OAuthConnection, type OAuthPort, type OAuthState } from './oauth-service'

const owner = '11111111-1111-4111-8111-111111111111', project = '22222222-2222-4222-8222-222222222222'
const config: OAuthConfiguration = { version: 1, environment: 'development', providerKey: 'example', authorization: { origin: 'https://login.example.com', path: '/authorize' }, token: { origin: 'https://login.example.com', path: '/token' }, clientId: 'client-public', clientAuthentication: 'none', scopes: ['profile', 'catalog:read'], connector: { version: 1, origin: 'https://api.example.com', authorization: 'bearer', identity: { path: '/me', field: 'id', account: 'account-41' }, operations: [{ name: 'catalog', method: 'GET', path: '/catalog', inputs: [], output: ['name'] }] } }
const redirect = 'https://supremo.example.com/auth/provider/callback'
function fixture() {
  let saved: OAuthState | null = null, connection: OAuthConnection | null = null, consumed = false, now = Date.now()
  const calls: ProtectedJsonRequest[] = []
  const request = vi.fn(async (input: ProtectedJsonRequest): Promise<unknown> => {
    calls.push(input)
    if (input.path === '/me') return { id: 'account-41' }
    const refresh = new URLSearchParams(input.body).get('grant_type') === 'refresh_token'
    return { access_token: refresh ? 'renewed-access-secret' : 'first-access-secret', refresh_token: refresh ? 'rotated-refresh-secret' : 'first-refresh-secret', expires_in: 120, token_type: 'Bearer', scope: 'profile catalog:read' }
  })
  const port: OAuthPort = {
    scope: { ownerId: owner, projectId: project }, now: () => now,
    authorize: vi.fn(async () => ({ policyId: owner, revision: project })),
    seal: (value, scope) => encryptCredential(value, { id: scope.id, userId: scope.ownerId, projectId: scope.projectId, environment: scope.environment }),
    open: (value, scope) => decryptCredential(value, { id: scope.id, userId: scope.ownerId, projectId: scope.projectId, environment: scope.environment }),
    provider: oauthProvider(request, async () => 'client-secret'),
    store: {
      async createState(value) { saved = value },
      async claimState(hash) { if (!saved || consumed || saved.stateHash !== hash) return null; consumed = true; return saved },
      async finishState(value, _claim, tokenCipher) { connection = { ...value, tokenCipher, state: 'active', version: 1, claim: null } },
      async failState() { consumed = true },
      async readConnection() { return connection ? { ...connection } : null },
      async claimRefresh(_id, version, claim) { if (!connection || connection.state !== 'active' || connection.version !== version) return false; connection.state = 'refreshing'; connection.claim = claim; return true },
      async finishRefresh(_id, version, claim, tokenCipher) { if (!connection || connection.version !== version || connection.claim !== claim || connection.state !== 'refreshing') throw new Error('CAS'); connection.tokenCipher = tokenCipher; connection.version++; connection.state = 'active'; connection.claim = null },
      async failRefresh(_id, version, claim) { if (connection?.version === version && connection.claim === claim) connection.state = 'uncertain' },
      async revoke() { if (connection) { connection.state = 'revoked'; connection.tokenCipher = '' } },
    },
  }
  const start = async (input = config) => {
    const result = await beginOAuth(port, input, redirect)
    const state = new URL(result.authorizationUrl).searchParams.get('state')!
    return { result, state }
  }
  const connect = async () => { const { state } = await start(); return completeOAuth(port, { state, code: 'callback-code' }) }
  return { port, calls, request, start, connect, state: () => saved!, connection: () => connection!, advance: (ms: number) => { now += ms } }
}
beforeEach(() => { vi.stubEnv('ENCRYPTION_KEY', 'ab'.repeat(32)) })
describe('owner-configured OAuth protocol', () => {
  it('persists only a state digest and encrypted PKCE verifier bound to project/provider/account', async () => {
    const f = fixture(), { result, state } = await f.start()
    const query = new URL(result.authorizationUrl).searchParams
    expect(oauthCallbackProjectId(state)).toBe(project)
    expect(f.state().stateHash).toBe(createHash('sha256').update(state).digest('hex'))
    expect(query.get('code_challenge_method')).toBe('S256')
    expect(query.get('code_challenge')).toBe(createHash('sha256').update(f.port.open(f.state().verifierCipher, f.state())).digest('base64url'))
    expect(query.has('code_verifier')).toBe(false)
    expect(f.state().config.connector.identity.account).toBe('account-41')
    expect(JSON.stringify(result)).not.toContain('client-secret')
    expect(() => f.port.open(f.state().verifierCipher, { ...f.state(), projectId: owner })).toThrow()
  })
  it('exchanges a code once, proves account identity and returns no tokens', async () => {
    const f = fixture(), { state } = await f.start()
    const completed = await completeOAuth(f.port, { state, code: 'callback-code' })
    expect(completed).toEqual({ connectionId: f.state().id, accountRef: 'account-41', verified: true })
    const form = new URLSearchParams(f.calls[0]!.body)
    expect(form.get('code_verifier')).toBe(f.port.open(f.state().verifierCipher, f.state()))
    expect(form.get('redirect_uri')).toBe(redirect)
    expect(form.get('grant_type')).toBe('authorization_code')
    expect(f.calls[1]!.authorization).toEqual({ kind: 'bearer', value: 'first-access-secret' })
    expect(JSON.stringify(completed)).not.toMatch(/access|refresh|secret/)
    expect(f.connection().tokenCipher).not.toContain('secret')
    expect(await oauthAccessToken(f.port, completed.connectionId)).toBe('first-access-secret')
    await expect(completeOAuth(f.port, { state, code: 'callback-code' })).rejects.toThrow(/já utilizada/)
    expect(f.calls).toHaveLength(2)
  })
  it.each(['expired', 'owner', 'issuer', 'revision'] as const)('consumes invalid %s state before any exchange', async reason => {
    const f = fixture(), { state } = await f.start({ ...config, issuer: config.authorization.origin })
    if (reason === 'expired') f.advance(600_001)
    if (reason === 'owner') f.port.scope.ownerId = project
    if (reason === 'revision') f.port.authorize = async () => ({ policyId: owner, revision: owner })
    const input = { state, code: 'code', issuer: reason === 'issuer' ? 'https://attacker.example.com' : config.authorization.origin }
    await expect(completeOAuth(f.port, input)).rejects.toThrow(/não confirmada/)
    expect(f.calls).toHaveLength(0)
    await expect(completeOAuth(f.port, input)).rejects.toThrow(/já utilizada/)
  })
  it.each(['account', 'scopes', 'missing-token', 'network'] as const)('does not connect when %s cannot be verified', async reason => {
    const f = fixture(), { state } = await f.start()
    f.request.mockImplementation(async request => {
      if (reason === 'network') throw new Error('secret-body-that-must-not-escape')
      if (request.path === '/me') return { id: reason === 'account' ? 'wrong-account' : 'account-41' }
      if (reason === 'missing-token') return { error: 'raw-sensitive-error' }
      return { access_token: 'access-secret', token_type: 'Bearer', scope: reason === 'scopes' ? 'admin' : 'profile catalog:read' }
    })
    await expect(completeOAuth(f.port, { state, code: 'code' })).rejects.toThrow(/^Conexão OAuth não confirmada/)
    expect(f.connection()).toBeNull()
    await expect(completeOAuth(f.port, { state, code: 'code' })).rejects.toThrow(/já utilizada/)
  })
  it('serializes concurrent refresh, rotates the token and verifies identity again', async () => {
    const f = fixture(), connected = await f.connect(); f.advance(61_000)
    const results = await Promise.allSettled([oauthAccessToken(f.port, connected.connectionId), oauthAccessToken(f.port, connected.connectionId)])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    expect(f.calls.filter(call => new URLSearchParams(call.body).get('grant_type') === 'refresh_token')).toHaveLength(1)
    expect(JSON.parse(f.port.open(f.connection().tokenCipher, f.connection()))).toMatchObject({ accessToken: 'renewed-access-secret', refreshToken: 'rotated-refresh-secret' })
    expect(f.connection().version).toBe(2)
    expect(f.calls.filter(call => call.path === '/me')).toHaveLength(2)
  })
  it.each(['provider', 'persistence', 'policy'] as const)('persists uncertain after refresh %s failure and never reuses its token', async reason => {
    const f = fixture(), connected = await f.connect(); f.advance(61_000)
    if (reason === 'provider') f.port.provider.refresh = async () => { throw new Error('lost response with secret') }
    if (reason === 'persistence') f.port.store.finishRefresh = async () => { throw new Error('database lost') }
    if (reason === 'policy') { let n = 0; f.port.authorize = async () => { if (++n > 1) throw new Error('revoked'); return { policyId: owner, revision: project } } }
    await expect(oauthAccessToken(f.port, connected.connectionId)).rejects.toThrow(/incerta/)
    expect(f.connection().state).toBe('uncertain')
    f.port.authorize = async () => ({ policyId: owner, revision: project })
    const calls = f.calls.length
    await expect(oauthAccessToken(f.port, connected.connectionId)).rejects.toThrow(/incerto/)
    expect(f.calls).toHaveLength(calls)
  })
  it('denies revoked credentials and cannot start without persistent owner authorization', async () => {
    const f = fixture(), connected = await f.connect()
    expect(await revokeOAuth(f.port, connected.connectionId)).toEqual({ revoked: true, verified: true })
    await expect(oauthAccessToken(f.port, connected.connectionId)).rejects.toThrow(/revogada/)
    const denied = fixture(); denied.port.authorize = async () => { throw new Error('policy disabled') }
    await expect(denied.start()).rejects.toThrow(/disabled/)
    expect(denied.state()).toBeNull()
  })
  it('does not treat a refresh response with missing expiration as a permanent credential', async () => {
    const f=fixture(), connected=await f.connect();f.advance(61_000)
    f.port.provider.refresh=async()=>({access_token:'next-secret',token_type:'Bearer'})
    await expect(oauthAccessToken(f.port,connected.connectionId)).rejects.toThrow(/incerta/)
    expect(f.connection().state).toBe('uncertain')
  })
  it('validates bounded endpoints, scopes, credentials and callback destinations', async () => {
    expect(oauthConfigurationSchema.safeParse({ ...config, token: { origin: 'http://127.0.0.1', path: '/token' } }).success).toBe(false)
    expect(oauthConfigurationSchema.safeParse({ ...config, scopes: ['profile', 'profile'] }).success).toBe(false)
    expect(oauthConfigurationSchema.safeParse({ ...config, clientAuthentication: 'client_secret_post' }).success).toBe(false)
    expect(oauthConfigurationSchema.safeParse({ ...config, authorization: { ...config.authorization, path: '/authorize?redirect_uri=evil' } }).success).toBe(false)
    await expect(beginOAuth(fixture().port, config, 'https://app.example.com/callback?secret=bad')).rejects.toThrow(/retorno/)
  })
  it('uses configured confidential-client authentication without leaking secrets into URLs', async () => {
    const f = fixture()
    const provider = oauthProvider(f.request, async () => 'client:secret+value')
    const confidential = { ...config, clientAuthentication: 'client_secret_basic' as const, clientSecretId: owner }
    await provider.exchange(confidential, { code: 'code', verifier: 'verifier', redirectUri: redirect })
    expect(f.calls[0]!.authorization).toEqual({ kind: 'basic', value: Buffer.from('client-public:client%3Asecret%2Bvalue').toString('base64') })
    expect(f.calls[0]!.body).not.toContain('client_secret')
    await provider.refresh({ ...confidential, clientAuthentication: 'client_secret_post' }, 'refresh-value')
    expect(new URLSearchParams(f.calls[1]!.body).get('client_secret')).toBe('client:secret+value')
    expect(f.calls[1]!.path).toBe('/token')
  })
})
