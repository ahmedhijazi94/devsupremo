import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { assertSameBinding, requireSecretBinding, safeSecretError, saveSecretSchema, secretEntrySchema, secretRequestView, secretsRequestSchema, SecretRequestError, type SecretBinding, type SecretEntry, type SecretRequestRecord } from './policy'
import { dismissRequestedSecret, fulfillSecret, listSecretRequests, requestSecrets, type SecretRequestPort } from './service'
import { deliverSecret } from './provider'

const projectId = '11111111-1111-4111-8111-111111111111'
const requestId = '22222222-2222-4222-8222-222222222222'
const entry: SecretEntry = { name: 'PAYMENT_API_KEY', description: 'Cobrar pagamentos no backend', target: 'supabase', environment: 'development' }
const binding: SecretBinding = { target: 'supabase', environment: 'development', accountId: 'account', targetRef: 'projectref' }
const row: SecretRequestRecord = { ...entry, ...binding, id: requestId, status: 'pending' }
function fixture(records: SecretRequestRecord[] = [row]) {
  const state = [...records]
  const port: SecretRequestPort = {
    authorize: vi.fn().mockResolvedValue(undefined), resolve: vi.fn().mockResolvedValue(binding), list: vi.fn(async () => state),
    insert: vi.fn(async (entries: Array<SecretEntry & SecretBinding>) => { state.push(...entries.map((item) => ({ ...item, id: requestId, status: 'pending' as const }))) }),
    find: vi.fn(async (id) => state.find((item) => item.id === id) ?? null), audit: vi.fn().mockResolvedValue(undefined),
    deliver: vi.fn().mockResolvedValue(undefined), fulfill: vi.fn().mockResolvedValue(undefined), dismiss: vi.fn().mockResolvedValue(undefined),
  }
  return port
}
beforeEach(() => vi.restoreAllMocks())

describe('secret request policy', () => {
  it.each(['NEXT_PUBLIC_API_KEY', 'VITE_API_KEY', 'PUBLIC_KEY', 'REACT_APP_KEY', 'NUXT_PUBLIC_KEY', 'NODE_OPTIONS', 'PATH', 'bad-name', 'A'.repeat(129)])('refuses public/reserved/invalid name %s', (name) => {
    expect(secretEntrySchema.safeParse({ ...entry, name }).success).toBe(false)
  })
  it('accepts metadata only with explicit target/environment and bounded context', () => {
    const payload = { projectId, deviceSecret: 'sup_dev_ckpt_fixture', operation: 'request', requests: [entry] }
    expect(secretsRequestSchema.safeParse(payload).success).toBe(true)
    for (const patch of [{ value: 'private-value' }, { requests: [{ ...entry, value: 'private-value' }] }, { requests: [{ ...entry, description: '' }] }, { requests: [{ ...entry, targetRef: 'foreign' }] }, { requests: Array(21).fill(entry) }]) expect(secretsRequestSchema.safeParse({ ...payload, ...patch }).success).toBe(false)
    expect(secretEntrySchema.safeParse({ ...entry, environment: 'preview' }).success).toBe(false)
    expect(secretEntrySchema.safeParse({ ...entry, name: 'SUPABASE_SERVICE_ROLE_KEY' }).success).toBe(false)
    expect(secretEntrySchema.safeParse({ ...entry, target: 'vercel', environment: 'preview' }).success).toBe(true)
    expect(secretsRequestSchema.safeParse({ projectId, deviceSecret: 'sup_dev_ckpt_fixture', operation: 'status' }).success).toBe(true)
    expect(secretsRequestSchema.safeParse({ projectId, deviceSecret: 'sup_dev_ckpt_fixture', operation: 'status', requests: [entry] }).success).toBe(false)
  })
  it('accepts a value only on the owner form, never a client-specified name/destination', () => {
    const input = { projectId, requestId, value: 'private-value' }
    expect(saveSecretSchema.safeParse(input).success).toBe(true)
    for (const extra of [{ name: 'OTHER_KEY' }, { target: 'vercel' }, { environment: 'production' }, { targetRef: 'foreign' }]) expect(saveSecretSchema.safeParse({ ...input, ...extra }).success).toBe(false)
    for (const value of ['', ' ', 'a\0b', 'a'.repeat(16385)]) expect(saveSecretSchema.safeParse({ ...input, value }).success).toBe(false)
  })
  it('pins Supabase only to the registered matching environment; Vercel uses the requested single environment', () => {
    const input = { ...binding, databaseEnvironment: { project_ref: binding.targetRef, environment: 'development', source: 'supremo_provisioned' } }
    expect(requireSecretBinding(input)).toEqual(binding)
    for (const patch of [{ targetRef: null }, { targetRef: '../foreign' }, { accountId: null }, { databaseEnvironment: null }, { environment: 'production' as const }, { targetRef: 'anotherref' }]) expect(() => requireSecretBinding({ ...input, ...patch })).toThrow(SecretRequestError)
    expect(requireSecretBinding({ ...input, target: 'vercel', environment: 'preview', databaseEnvironment: null })).toMatchObject({ target: 'vercel', environment: 'preview' })
    for (const patch of [{ target: 'vercel' as const }, { environment: 'production' as const }, { targetRef: 'newref' }, { accountId: 'other' }]) expect(() => assertSameBinding(row, { ...binding, ...patch })).toThrow(/destino mudou/)
    expect(secretRequestView({ ...row, value: 'private-value' } as SecretRequestRecord)).not.toHaveProperty('value')
    expect(secretRequestView(row)).not.toHaveProperty('accountId')
    expect(safeSecretError(new Error('token=private-value'))).not.toContain('private-value')
  })
  it('migration preserves old records without guessing destinations and requires actual project ownership', () => {
    const sql = readFileSync('supabase/migrations/024_scoped_secret_requests.sql', 'utf8')
    expect(sql).toContain('target IS NULL AND environment IS NULL AND target_ref IS NULL')
    expect(sql).toContain('target_ref IS NOT NULL')
    expect(sql.match(/p\.id = project_id AND p\.user_id = auth\.uid\(\)/g)).toHaveLength(2)
    expect(sql).toContain('UNIQUE (project_id, name, target, environment, target_ref, target_account_id)')
    expect(sql).toContain('REVOKE INSERT, UPDATE ON public.secret_requests FROM PUBLIC, anon, authenticated')
    expect(sql).toContain('FOR SELECT TO authenticated')
    expect(sql).toContain('FOR DELETE TO authenticated')
    expect(sql).not.toMatch(/FOR (ALL|INSERT|UPDATE) TO authenticated/)
    expect(sql).not.toMatch(/ADD COLUMN\s+(value|secret_value|token)\b/i)
  })
})

describe('secret request service', () => {
  it('deduplicates exact destination requests and never resets fulfilled status on a retry', async () => {
    const port = fixture([])
    const result = await requestSecrets(port, [entry, entry])
    expect(port.insert).toHaveBeenCalledWith([{ ...entry, ...binding }])
    expect(result).toEqual([secretRequestView(row)])
    const fulfilled = fixture([{ ...row, status: 'fulfilled' }])
    expect(await requestSecrets(fulfilled, [entry])).toEqual([secretRequestView({ ...row, status: 'fulfilled' })])
    expect(fulfilled.insert).not.toHaveBeenCalled()
  })
  it('refuses unauthorized projects before reading or writing any metadata', async () => {
    for (const action of [(port: SecretRequestPort) => listSecretRequests(port), (port: SecretRequestPort) => requestSecrets(port, [entry]), (port: SecretRequestPort) => fulfillSecret(port, requestId, 'private'), (port: SecretRequestPort) => dismissRequestedSecret(port, requestId)]) {
      const port = fixture(); vi.mocked(port.authorize).mockRejectedValue(new SecretRequestError('unauthorized'))
      await expect(action(port)).rejects.toThrow('unauthorized')
      for (const method of [port.list, port.insert, port.find, port.deliver, port.dismiss]) expect(method).not.toHaveBeenCalled()
    }
  })
  it('resolves all requested destinations before persisting and enforces a bounded project quota', async () => {
    const port = fixture([]); vi.mocked(port.resolve).mockRejectedValue(new SecretRequestError('environment mismatch'))
    await expect(requestSecrets(port, [entry])).rejects.toThrow('environment mismatch'); expect(port.insert).not.toHaveBeenCalled()
    const full = fixture(Array.from({ length: 100 }, (_, i) => ({ ...row, name: `KEY_${i}` })))
    await expect(requestSecrets(full, [entry])).rejects.toThrow('Limite de 100'); expect(full.insert).not.toHaveBeenCalled()
  })
  it('passes the submitted value only to the provider; audit and persistence receive metadata', async () => {
    const port = fixture()
    await fulfillSecret(port, requestId, 'private-value')
    expect(port.deliver).toHaveBeenCalledExactlyOnceWith(row, binding, 'private-value')
    expect(port.audit).toHaveBeenCalledExactlyOnceWith(row)
    expect(port.fulfill).toHaveBeenCalledExactlyOnceWith(row)
    expect(JSON.stringify([vi.mocked(port.audit).mock.calls, vi.mocked(port.fulfill).mock.calls])).not.toContain('private-value')
    expect(vi.mocked(port.audit).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(port.deliver).mock.invocationCallOrder[0]!)
  })
  it.each([null, { ...row, target: null }, { ...row, environment: null }, { ...row, targetRef: null }, { ...row, accountId: null }, { ...row, name: 'NEXT_PUBLIC_KEY' }])('refuses missing, legacy or tampered persisted request %#', async (record) => {
    const port = fixture(record ? [record] : [])
    await expect(fulfillSecret(port, requestId, 'private-value')).rejects.toThrow()
    expect(port.deliver).not.toHaveBeenCalled()
  })
  it('refuses relinked destinations and treats a confirmed repeated save as idempotent', async () => {
    const port = fixture(); vi.mocked(port.resolve).mockResolvedValue({ ...binding, targetRef: 'foreign' })
    await expect(fulfillSecret(port, requestId, 'private-value')).rejects.toThrow(/destino mudou/); expect(port.deliver).not.toHaveBeenCalled()
    const done = fixture([{ ...row, status: 'fulfilled' }]); await fulfillSecret(done, requestId, 'private-value'); expect(done.deliver).not.toHaveBeenCalled()
  })
  it('does not send when audit fails and never marks fulfilled when provider rejects', async () => {
    const port = fixture(); vi.mocked(port.audit).mockRejectedValue(new Error('db down'))
    await expect(fulfillSecret(port, requestId, 'private-value')).rejects.toThrow(); expect(port.deliver).not.toHaveBeenCalled()
    const rejected = fixture(); vi.mocked(rejected.deliver).mockRejectedValue(new Error('provider down'))
    await expect(fulfillSecret(rejected, requestId, 'private-value')).rejects.toThrow(); expect(rejected.fulfill).not.toHaveBeenCalled()
  })
  it('reports uncertain persisted confirmation honestly without exposing provider payload', async () => {
    const port = fixture(); vi.mocked(port.fulfill).mockRejectedValue(new Error('private-value'))
    await expect(fulfillSecret(port, requestId, 'private-value')).rejects.toThrow('O valor foi enviado ao destino')
    await expect(fulfillSecret(port, requestId, 'private-value')).rejects.not.toThrow('private-value')
    await dismissRequestedSecret(port, requestId); expect(port.dismiss).toHaveBeenCalledExactlyOnceWith(requestId)
  })
})

describe('secret provider transport', () => {
  it('sends only to the pinned Supabase project with redirects disabled and returns no value', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 201 }))
    expect(await deliverSecret(binding, entry.name, 'private-value', 'oauth-token', null)).toBeUndefined()
    const [url, options] = fetcher.mock.calls[0]!
    expect(String(url)).toBe('https://api.supabase.com/v1/projects/projectref/secrets')
    expect(options).toMatchObject({ method: 'POST', redirect: 'error', body: JSON.stringify([{ name: entry.name, value: 'private-value' }]) })
  })
  it('sends a Vercel secret encrypted to only the selected environment and team', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ created: { id: 'env-id', key: entry.name, type: 'encrypted', target: ['preview'], value: 'private-value' }, failed: [] }))
    expect(await deliverSecret({ ...binding, target: 'vercel', environment: 'preview' }, entry.name, 'private-value', 'oauth-token', 'team1')).toBeUndefined()
    expect(String(fetcher.mock.calls[0]![0])).toBe('https://api.vercel.com/v10/projects/projectref/env?upsert=true&teamId=team1')
    expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string)).toEqual({ key: entry.name, value: 'private-value', type: 'encrypted', target: ['preview'] })
  })
  it.each([new Response('private-value', { status: 500 }), Response.json({ failed: [{ message: 'private-value' }] }), Response.json({}), Response.json({ created: null }), Response.json({ created: [] }), Response.json({ created: {} }), Response.json({ created: { id: 'env', key: entry.name, type: 'encrypted', target: ['production'] } }), Response.json({ created: { id: 'env', key: 'OTHER_KEY', type: 'encrypted', target: ['development'] } }), new Response('invalid'), new Response('x'.repeat(65000))])('does not expose unsuccessful provider responses %#', async (response) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response)
    try { await deliverSecret({ ...binding, target: 'vercel' }, entry.name, 'private-value', 'oauth-token', null); expect.fail('must reject') }
    catch (error) { expect(error).toBeInstanceOf(SecretRequestError); expect(safeSecretError(error)).not.toMatch(/private-value|oauth-token/) }
  })
  it('redacts thrown network/redirect failures', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('redirect oauth-token private-value'))
    await expect(deliverSecret(binding, entry.name, 'private-value', 'oauth-token', null)).rejects.toThrow('O provedor não confirmou')
  })
})
