import { describe, it, expect, vi } from 'vitest'
import { integrationConnectionInputSchema, integrationConnectionSchema, integrationOptionsSchema, IntegrationError, type IntegrationConnection, type IntegrationOptions, type IntegrationReceipt } from './contract'
import { assertConnectionOperation, executeProviderOperation, inspectProviderIdentity, stripeProductId, TEST_EMAIL_SUBJECT } from './providers'
import { genericConnectorSchema, connectorOriginSchema, selectedField, safeProjectedValue, rejectCredentialEcho, validateGenericInputs } from './generic-contract'
import { assertProviderPath, publicProviderAddress, type ProviderTransport } from './transport'
import { integrationRequestHash, runIntegration, type IntegrationPort, type IntegrationSession } from './service'

const owner = '11111111-1111-4111-8111-111111111111', project = '22222222-2222-4222-8222-222222222222', id = '33333333-3333-4333-8333-333333333333', operationId = '44444444-4444-4444-8444-444444444444', credentialId = '55555555-5555-4555-8555-555555555555', mailId = '66666666-6666-4666-8666-666666666666'
// Synthetic provider-shaped values; never credentials issued by a provider.
const now = '2026-10-05T12:00:00.000Z', secret = 're_' + 'x'.repeat(20)
const base: IntegrationConnection = integrationConnectionSchema.parse({ id, projectId: project, ownerId: owner, credentialId, environment: 'development', provider: 'resend', allowedSenders: ['from@example.com'], allowedRecipients: ['to@example.com'], allowedRepositories: [], accountRef: `credential:${credentialId}`, accountIdentityVerified: false, revokedAt: null, createdAt: now })
const mail: IntegrationOptions = { operation: 'resend-send-test', connectionId: id, operationId, from: 'from@example.com', to: 'to@example.com' }
const product: IntegrationOptions = { operation: 'stripe-create-test-product', connectionId: id, operationId, name: 'Teste' }
const repository: IntegrationOptions = { operation: 'github-repository', connectionId: id, operationId, owner: 'owner', repository: 'repo' }
const contract = genericConnectorSchema.parse({ version: 1, origin: 'https://api.example.com', authorization: 'bearer', identity: { path: '/account', field: 'id', account: 'account-1' }, operations: [
  { name: 'read', method: 'GET', path: '/settings', output: ['enabled'] },
  { name: 'configure', method: 'PATCH', path: '/settings', inputs: [{ name: 'enabled', type: 'boolean' }], output: ['enabled'], verify: { path: '/settings', matchInputs: ['enabled'] } },
  { name: 'create', method: 'POST', path: '/widgets', inputs: [{ name: 'name', type: 'string', maxLength: 10, choices: ['test'] }], output: ['name'], verify: { path: '/widgets', idField: 'id', matchInputs: ['name'] } },
] })
const generic: IntegrationConnection = { ...base, provider: 'generic', contract, accountRef: 'account-1', accountIdentityVerified: true }
const configure: IntegrationOptions = { operation: 'generic-call', connectionId: id, operationId, name: 'configure', input: { enabled: true } }
const delivered = { id: mailId, from: mail.from, to: [mail.to], subject: TEST_EMAIL_SUBJECT, last_event: 'delivered', privateMetadata: 'ignored' }
function fixture(connection = base, options = mail) {
  let state: IntegrationSession | null = null
  const receipt = (): IntegrationReceipt => ({ operation: options.operation, operationId, connectionId: id, status: 'running', resourceId: null, effectVerified: false, evidence: {}, observedAt: now, valuesReceived: false })
  const port = {
    authorize: vi.fn(async () => undefined), connection: vi.fn(async () => connection), credential: vi.fn(async () => secret),
    start: vi.fn(async (_options: IntegrationOptions, hash: string) => { state ??= { requestHash: hash, createdAt: now, receipt: receipt() }; return structuredClone(state) }),
    claim: vi.fn(async () => undefined), assertClaim: vi.fn(async () => undefined), release: vi.fn(async () => undefined),
    save: vi.fn(async (value: IntegrationReceipt) => { state!.receipt = structuredClone(value) }),
    request: vi.fn<ProviderTransport>(async request => request.method === 'POST' ? { id: mailId } : delivered), now: () => new Date(now),
  } satisfies IntegrationPort
  return { port, get: () => state!, set: (patch: Partial<IntegrationSession>) => { state = { requestHash: integrationRequestHash(options), createdAt: now, receipt: receipt(), ...patch } } }
}

describe('approved destination and response boundaries', () => {
  it.each(['127.0.0.1', '10.1.1.1', '169.254.169.254', '100.64.1.1', '172.31.2.3', '192.168.0.1', '192.0.0.5', '192.2.1.3', '192.88.99.1', '198.19.0.1', '198.51.100.2', '203.0.113.4', '224.0.0.1', '0.0.0.0', '::1', '::ffff:127.0.0.1', 'bad'])('rejects nonpublic address %s', address => expect(publicProviderAddress(address)).toBe(false))
  it('permits public IPv4 only', () => { expect(publicProviderAddress('8.8.8.8')).toBe(true); expect(publicProviderAddress('172.32.1.1')).toBe(true) })
  it.each(['http://api.example.com', 'https://user:pass@api.example.com', 'https://127.0.0.1', 'https://api.local', 'https://api.example.com:8443', 'https://api.example.com/path', 'https://localhost'])('rejects unsafe origin %s', origin => expect(connectorOriginSchema.safeParse(origin).success).toBe(false))
  it('binds paths/methods to approved operations, refusing expansion by provider data', () => {
    for (const [provider, path, method] of [['resend', '/emails', 'POST'], ['stripe-test', '/v1/account', 'GET'], ['github', '/repos/owner/repo', 'GET']] as const) expect(() => assertProviderPath({ provider, path, method, credential: secret })).not.toThrow()
    for (const [path, method] of [['/admin', 'GET'], ['/settings', 'DELETE'], ['https://evil.com', 'GET'], ['/widgets/../../admin', 'GET']] as const) expect(() => assertProviderPath({ provider: 'generic', contract, path, method, credential: secret })).toThrow()
    expect(() => assertProviderPath({ provider: 'generic', contract, path: '/widgets/widget-1', method: 'GET', credential: secret })).not.toThrow()
    expect(() => assertProviderPath({ provider: 'resend', path: '/emails', method: 'POST', credential: 'bad\r\nHost:evil' })).toThrow()
    expect(() => assertProviderPath({ provider: 'resend', path: '/emails', method: 'POST', credential: secret, body: 'x'.repeat(16001) })).toThrow()
  })
  it('requires owner-approved contracts, sandbox and provider-specific scope', () => {
    const input = { projectId: project, credentialId, environment: 'development', provider: 'generic', contract }
    expect(integrationConnectionInputSchema.parse(input).contract).toEqual(contract)
    for (const patch of [{ contract: undefined }, { provider: 'github' }, { provider: 'stripe-test', environment: 'production', contract: undefined }]) expect(integrationConnectionInputSchema.safeParse({ ...input, ...patch }).success).toBe(false)
    expect(integrationOptionsSchema.safeParse({ ...configure, url: 'https://evil.com' }).success).toBe(false)
    expect(() => assertConnectionOperation({ ...base, revokedAt: now }, mail)).toThrow()
    expect(() => assertConnectionOperation(base, { ...mail, to: 'other@example.com' })).toThrow()
    expect(() => assertConnectionOperation(base, repository)).toThrow()
    expect(() => assertConnectionOperation({ ...base, provider: 'stripe-test', environment: 'production' }, product)).toThrow()
  })
  it('projects scalar fields and blocks credential echo including common encodings', () => {
    expect(selectedField({ a: { b: 2 } }, 'a.b')).toBe(2)
    expect(selectedField({ a: [] }, 'a.0')).toBeUndefined()
    expect(selectedField({}, '__proto__.x')).toBeUndefined()
    for (const value of [secret, encodeURIComponent(secret), Buffer.from(secret).toString('base64'), Buffer.from(secret).toString('hex')]) {
      expect(() => safeProjectedValue(`echo ${value}`, secret)).toThrow(); expect(() => rejectCredentialEcho({ nested: [value] }, secret)).toThrow()
    }
    expect(() => safeProjectedValue({ token: secret }, secret)).toThrow()
    expect(() => safeProjectedValue('new\nline', secret)).toThrow()
    expect(safeProjectedValue(false, secret)).toBe(false)
    expect(() => genericConnectorSchema.parse({ ...contract, operations: [{ ...contract.operations[0], output: ['access_token'] }] })).toThrow()
  })
  it('validates operation fields without treating provider documentation as authority', () => {
    const create = contract.operations[2]!
    expect(validateGenericInputs(create, { name: 'test' })).toEqual({ name: 'test' })
    for (const input of [{ name: 'bad' }, { name: true }, { name: 'test', extra: true }, {}]) expect(() => validateGenericInputs(create, input)).toThrow()
    expect(() => genericConnectorSchema.parse({ ...contract, operations: [{ ...create, verify: undefined }] })).toThrow()
    expect(() => genericConnectorSchema.parse({ ...contract, operations: [create, create] })).toThrow()
  })
})
describe('provider effects and scope', () => {
  it('binds account identity and rejects production payment keys', async () => {
    const request = vi.fn<ProviderTransport>().mockResolvedValueOnce({ livemode: false }).mockResolvedValueOnce({ id: 'acct_test' })
    expect(await inspectProviderIdentity('stripe-test', 'sk_test_' + 'x'.repeat(12), request, credentialId)).toEqual({ accountRef: 'acct_test', accountIdentityVerified: true })
    await expect(inspectProviderIdentity('stripe-test', 'sk_live_' + 'x'.repeat(12), request, credentialId)).rejects.toThrow()
    await expect(inspectProviderIdentity('resend', 'other', request, credentialId)).rejects.toThrow()
    request.mockResolvedValueOnce({ id: 123 })
    expect(await inspectProviderIdentity('github', secret, request, credentialId)).toMatchObject({ accountRef: 'github:123' })
    request.mockResolvedValueOnce({ id: 'other-account' })
    await expect(inspectProviderIdentity('generic', secret, request, credentialId, contract)).rejects.toThrow('conta diferente')
  })
  it('distinguishes accepted email from delivered email and validates recipient', async () => {
    const request = vi.fn<ProviderTransport>().mockResolvedValueOnce({ ...delivered, last_event: 'sent' })
    const progress = vi.fn()
    expect(await executeProviderOperation(base, mail, secret, request, progress, mailId)).toMatchObject({ effectVerified: false, evidence: { messageAccepted: true, messageDelivered: false } })
    expect(progress).not.toHaveBeenCalled()
    request.mockResolvedValueOnce({ ...delivered, to: ['wrong@example.com'] })
    await expect(executeProviderOperation(base, mail, secret, request, progress, mailId)).rejects.toThrow()
  })
  it('reconciles deterministic sandbox product before creating, never confirms a payment', async () => {
    const connection = { ...base, provider: 'stripe-test' as const }, productId = stripeProductId(project, operationId)
    const record = { id: productId, name: 'Teste', livemode: false, metadata: { supremo_operation: operationId }, rawToken: 'omitted' }
    const request = vi.fn<ProviderTransport>().mockRejectedValueOnce(new IntegrationError('Missing', 'unavailable', 404)).mockResolvedValueOnce(record).mockResolvedValueOnce(record)
    expect(await executeProviderOperation(connection, product, secret, request, vi.fn(), null)).toMatchObject({ resourceId: productId, effectVerified: true, evidence: { paymentVerified: false } })
    const reconcile = vi.fn<ProviderTransport>().mockResolvedValue(record)
    await executeProviderOperation(connection, product, secret, reconcile, vi.fn(), null)
    expect(reconcile).toHaveBeenCalledTimes(1)
    request.mockRejectedValueOnce(new IntegrationError('Limited', 'rate_limited', 429))
    await expect(executeProviderOperation(connection, product, secret, request, vi.fn(), null)).rejects.toThrow('Limited')
  })
  it('projects GitHub metadata and rejects repository substitution', async () => {
    const connection = { ...base, provider: 'github' as const, allowedRepositories: ['owner/repo'] }, record = { id: 42, full_name: 'owner/repo', private: true, archived: false, default_branch: 'main', privateData: secret }
    const request = vi.fn<ProviderTransport>().mockResolvedValue(record)
    const result = await executeProviderOperation(connection, repository, secret, request, vi.fn(), null)
    expect(result.resourceId).toBe('42'); expect(JSON.stringify(result)).not.toContain(secret)
    request.mockResolvedValue({ ...record, full_name: 'other/repo' })
    await expect(executeProviderOperation(connection, repository, secret, request, vi.fn(), null)).rejects.toThrow()
  })
  it('runs custom read and verified mutation with only approved output fields', async () => {
    const request = vi.fn<ProviderTransport>().mockResolvedValue({ enabled: true, omitted: 'private' })
    expect(await executeProviderOperation(generic, configure, secret, request, vi.fn(), null)).toMatchObject({ effectVerified: true, resourceId: 'fixed-resource', evidence: { enabled: true } })
    expect(request.mock.calls.map(call => call[0].method)).toEqual(['PATCH', 'GET'])
    const read = { ...configure, name: 'read', input: {} }
    expect(await executeProviderOperation(generic, read, secret, request, vi.fn(), null)).toMatchObject({ resourceId: 'read', effectVerified: true })
    request.mockResolvedValueOnce({ id: 'widget-1' }).mockResolvedValueOnce({ name: 'test' })
    expect(await executeProviderOperation(generic, { ...configure, name: 'create', input: { name: 'test' } }, secret, request, vi.fn(), null)).toMatchObject({ resourceId: 'widget-1' })
    request.mockResolvedValue({ enabled: false })
    await expect(executeProviderOperation(generic, configure, secret, request, vi.fn(), 'fixed-resource')).rejects.toThrow('Estado observado')
  })
})
describe('persistent integration orchestration', () => {
  it('persists resource progress, reuses completed receipt and never exposes credential', async () => {
    const { port } = fixture()
    const first = await runIntegration(port, mail)
    expect(first).toMatchObject({ status: 'completed', resourceId: mailId, effectVerified: true })
    expect(port.save.mock.calls[0]![0].status).toBe('verifying')
    expect(JSON.stringify(first)).not.toContain(secret)
    expect(await runIntegration(port, mail)).toEqual(first)
    expect(port.request).toHaveBeenCalledTimes(2)
    expect(port.release).toHaveBeenCalledTimes(1)
  })
  it('refuses conflicting idempotency requests and expired email replay', async () => {
    const f = fixture(); f.set({ requestHash: 'other' })
    await expect(runIntegration(f.port, mail)).rejects.toThrow('outro pedido')
    f.set({ createdAt: '2026-10-01T00:00:00.000Z' })
    await expect(runIntegration(f.port, mail)).rejects.toThrow('janela segura')
    expect(f.port.request).not.toHaveBeenCalled()
  })
  it('captures uncertain effects without raw exception details and retains observed ID', async () => {
    const f = fixture(); f.port.request.mockResolvedValueOnce({ id: mailId }).mockRejectedValueOnce(new Error(`payload ${secret}`))
    const result = await runIntegration(f.port, mail)
    expect(result).toMatchObject({ status: 'outcome_unknown', resourceId: mailId })
    expect(JSON.stringify(result)).not.toContain(secret)
    f.port.request.mockResolvedValue(delivered)
    expect(await runIntegration(f.port, mail)).toMatchObject({ status: 'completed' })
    expect(f.port.request.mock.calls.filter(call => call[0].method === 'POST')).toHaveLength(1)
  })
  it('blocks generic mutation replay after uncertain dispatch, including stale pre-claim snapshots', async () => {
    const f = fixture(generic, configure)
    f.port.request.mockImplementation(async request => { if (request.path === '/account') return { id: 'account-1' }; throw new Error('remote timeout') })
    expect(await runIntegration(f.port, configure)).toMatchObject({ status: 'outcome_unknown', evidence: { dispatchAttempted: true } })
    await expect(runIntegration(f.port, configure)).rejects.toThrow('não repetirá')
    expect(f.port.request.mock.calls.filter(call => call[0].method === 'PATCH')).toHaveLength(1)
    const stale = fixture(generic, configure); stale.set(f.get())
    stale.port.start.mockResolvedValueOnce({ ...f.get(), receipt: { ...f.get().receipt, evidence: {} } }).mockResolvedValueOnce(f.get())
    expect(await runIntegration(stale.port, configure)).toMatchObject({ status: 'outcome_unknown' })
    expect(stale.port.request).not.toHaveBeenCalled()
  })
  it('rechecks connection changes, credential revocation, account mismatch and echoed secrets', async () => {
    const changed = fixture(); changed.port.connection.mockResolvedValueOnce(base).mockResolvedValue({ ...base, revokedAt: now })
    expect(await runIntegration(changed.port, mail)).toMatchObject({ status: 'outcome_unknown' }); expect(changed.port.request).not.toHaveBeenCalled()
    const revoked = fixture(); revoked.port.credential.mockRejectedValue(new IntegrationError('Revoked', 'forbidden'))
    expect(await runIntegration(revoked.port, mail)).toMatchObject({ status: 'outcome_unknown' })
    const account = fixture({ ...base, accountRef: 'other' })
    expect(await runIntegration(account.port, mail)).toMatchObject({ status: 'outcome_unknown' }); expect(account.port.request).not.toHaveBeenCalled()
    const echoed = fixture(); echoed.port.request.mockResolvedValue({ id: mailId, token: secret })
    expect(await runIntegration(echoed.port, mail)).toMatchObject({ status: 'outcome_unknown', resourceId: null })
  })
  it('propagates persistence failure instead of reporting success and always releases its lease', async () => {
    const f = fixture(); f.port.save.mockRejectedValue(new IntegrationError('Persistence failure', 'outcome_unknown'))
    await expect(runIntegration(f.port, mail)).rejects.toThrow('Persistence')
    expect(f.port.release).toHaveBeenCalledOnce()
  })
})
