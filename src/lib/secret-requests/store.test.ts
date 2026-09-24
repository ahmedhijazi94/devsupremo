import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
const mocks = vi.hoisted(() => ({ environment: vi.fn(), project: vi.fn(), credentials: vi.fn(), decrypt: vi.fn(), deliver: vi.fn() }))
vi.mock('@/lib/database-environment/store', () => ({ readEnvironment: mocks.environment }))
vi.mock('@/lib/projects/repository', () => ({ getProject: mocks.project, getSupabaseCredentials: mocks.credentials }))
vi.mock('@/lib/crypto', () => ({ decryptToken: mocks.decrypt }))
vi.mock('./provider', () => ({ deliverSecret: mocks.deliver }))
import { secretRequestStore } from './store'
import { fulfillSecret } from './service'
import { SecretRequestError, type SecretConfiguration, type SecretRequestRecord } from './policy'
const projectId = '11111111-1111-4111-8111-111111111111'
const requestId = '22222222-2222-4222-8222-222222222222'
const accountId = '33333333-3333-4333-8333-333333333333'
const project = { id: projectId, supabase_account_id: accountId, supabase_project_ref: 'projectref', vercel_account_id: accountId, vercel_project_id: 'vercelproject' }
const row = { id: requestId, name: 'PAYMENT_API_KEY', description: 'Backend', target: 'supabase', environment: 'development', target_ref: 'projectref', target_account_id: accountId, status: 'pending' }
const record: SecretRequestRecord = { id: requestId, name: row.name, description: row.description, target: 'supabase', environment: 'development', targetRef: 'projectref', accountId, status: 'pending' }
const claim = { id: '55555555-5555-4555-8555-555555555555', expiresAt: '2100-01-01T00:00:00.000Z' }
interface Call { table: string; method: string; payload?: unknown; options?: unknown; filters: Array<[string, unknown]>; columns?: string; limit?: number; or?: string; greaterThan?: Array<[string, string]> }
interface Result { data: unknown; error: unknown }
function clientFixture(override?: (call: Call, index: number) => Result | undefined) {
  const calls: Call[] = []
  const from = (table: string) => {
    const call: Call = { table, method: 'select', filters: [] }
    const result = () => {
      calls.push(call)
      const special = override?.(call, calls.length)
      if (special) return special
      if (table === 'projects') return { data: project, error: null }
      if (table.endsWith('_accounts')) return { data: { id: accountId, access_token_encrypted: 'ciphertext', team_id: 'team' }, error: null }
      if (table === 'secret_requests' && call.method === 'select') return { data: call.filters.some(([key]) => key === 'id') ? row : [row], error: null }
      return { data: { id: requestId }, error: null }
    }
    const chain = {
      select(columns: string) { call.columns = columns; return chain },
      eq(key: string, value: unknown) { call.filters.push([key, value]); return chain },
      is(key: string, value: null) { call.filters.push([key, value]); return chain },
      gt(key: string, value: string) { (call.greaterThan ??= []).push([key, value]); return chain },
      or(filter: string) { call.or = filter; return chain },
      order() { return chain }, limit(value: number) { call.limit = value; return chain },
      update(payload: unknown) { call.method = 'update'; call.payload = payload; return chain },
      insert(payload: unknown) { call.method = 'insert'; call.payload = payload; return chain },
      upsert(payload: unknown, options: unknown) { call.method = 'upsert'; call.payload = payload; call.options = options; return chain },
      delete() { call.method = 'delete'; return chain },
      maybeSingle() { return Promise.resolve(result()) },
      then(resolve: (value: Result) => unknown, reject?: (reason: unknown) => unknown) { return Promise.resolve(result()).then(resolve, reject) },
    }
    return chain
  }
  return { client: { from } as unknown as SupabaseClient, calls }
}
/** Emulate row compare-and-set filters; races are also checked against real PostgreSQL. */
function configuredFixture(configuration: SecretConfiguration | null) {
  const state: { row: Record<string, unknown> | null } = { row: { ...row, configuration, project_id: projectId, user_id: 'owner', delivery_claim_id: null, delivery_claim_expires_at: null } }
  const fixture = clientFixture((call) => {
    if (call.table !== 'secret_requests') return undefined
    const current = state.row
    if (!current) return { data: null, error: null }
    const matches = call.filters.every(([key, value]) => key === 'configuration' && value !== null ? JSON.stringify(current.configuration) === value : current[key] === value)
      && (call.greaterThan ?? []).every(([key, value]) => Date.parse(String(current[key])) > Date.parse(value))
    const claimAvailable = !current.delivery_claim_id || Date.parse(String(current.delivery_claim_expires_at)) <= Date.now()
    if (!matches || (call.or && !claimAvailable)) return { data: null, error: null }
    if (call.method === 'update') Object.assign(current, call.payload)
    if (call.method === 'delete') state.row = null
    return { data: call.filters.some(([key]) => key === 'id') ? { ...current } : [{ ...current }], error: null }
  })
  return { ...fixture, state }
}
beforeEach(() => {
  vi.restoreAllMocks()
  vi.resetAllMocks()
  mocks.environment.mockResolvedValue({ project_ref: 'projectref', environment: 'development', source: 'supremo_provisioned' })
  mocks.project.mockResolvedValue(project)
  mocks.credentials.mockResolvedValue({ projectRef: 'projectref', token: 'oauth-token' })
  mocks.decrypt.mockReturnValue('vercel-token')
})
describe('owner scoped secret request store', () => {
  it.each(['generic', 'smtp'] as const)('stops %s dispatch if its vault credential is removed during provider credential lookup', async (kind) => {
    const configuration = kind === 'smtp' ? { kind: 'supabase-smtp' as const, provider: 'resend' as const, senderEmail: 'account@example.test', senderName: 'Example' } : null
    const fixture = configuredFixture(configuration)
    let available = true
    const verifyCredential = vi.fn(async () => { if (!available) throw new SecretRequestError('A credencial foi removida do cofre. Solicite um novo campo seguro.') })
    const port = secretRequestStore(fixture.client, 'owner', projectId, verifyCredential)
    mocks.credentials.mockImplementation(async () => {
      available = false
      return { projectRef: 'projectref', token: 'oauth-token' }
    })
    const fetcher = vi.spyOn(globalThis, 'fetch')
    await expect(fulfillSecret(port, requestId, 'stored-private-value')).rejects.toThrow('removida do cofre')
    expect(mocks.credentials).toHaveBeenCalledTimes(1)
    expect(verifyCredential).toHaveBeenCalledTimes(2)
    expect(fetcher).not.toHaveBeenCalled()
    expect(mocks.deliver).not.toHaveBeenCalled()
    expect(fixture.state.row).toMatchObject({ status: 'pending', delivery_claim_id: null, delivery_claim_expires_at: null })
    expect(fixture.calls.some((call) => call.method === 'update' && JSON.stringify(call.payload).includes('fulfilled'))).toBe(false)
    expect(JSON.stringify(fixture.calls)).not.toMatch(/stored-private-value|oauth-token/)
  })
  it('rechecks the vault credential between SMTP update and verification instead of falsely confirming a revoked operation', async () => {
    const configuration = { kind: 'supabase-smtp' as const, provider: 'resend' as const, senderEmail: 'account@example.test', senderName: 'Example' }
    const fixture = configuredFixture(configuration)
    let available = true
    const verifyCredential = vi.fn(async () => { if (!available) throw new SecretRequestError('A credencial foi removida do cofre. Solicite um novo campo seguro.') })
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      available = false
      return Response.json({})
    })
    const port = secretRequestStore(fixture.client, 'owner', projectId, verifyCredential)
    await expect(fulfillSecret(port, requestId, 'stored-private-value')).rejects.toThrow('removida do cofre')
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: 'PATCH' })
    expect(mocks.credentials).toHaveBeenCalledTimes(1)
    expect(verifyCredential).toHaveBeenCalledTimes(3)
    expect(fixture.state.row).toMatchObject({ status: 'pending', delivery_claim_id: null, delivery_claim_expires_at: null })
    expect(fixture.calls.some((call) => call.method === 'update' && JSON.stringify(call.payload).includes('fulfilled'))).toBe(false)
    expect(JSON.stringify(fixture.calls)).not.toMatch(/stored-private-value|oauth-token/)
  })
  it('reserves ordinary API-key fields too, blocking dismissal and duplicate sends until confirmation', async () => {
    const fixture = configuredFixture(null); const port = secretRequestStore(fixture.client, 'owner', projectId)
    let finishCredentials: ((value: { projectRef: string; token: string }) => void) | undefined
    const credentials = new Promise<{ projectRef: string; token: string }>((resolve) => { finishCredentials = resolve })
    mocks.credentials.mockReturnValueOnce(credentials)
    const first = fulfillSecret(port, requestId, 'first-private-value')
    await vi.waitFor(() => expect(mocks.credentials).toHaveBeenCalledTimes(1))
    await expect(fulfillSecret(port, requestId, 'second-private-value')).rejects.toThrow('já está sendo enviado')
    await expect(port.dismiss(requestId)).rejects.toThrow('está sendo enviado')
    expect(mocks.deliver).not.toHaveBeenCalled()
    finishCredentials?.({ projectRef: 'projectref', token: 'oauth-token' })
    await first
    expect(mocks.deliver).toHaveBeenCalledExactlyOnceWith({ target: 'supabase', environment: 'development', targetRef: 'projectref', accountId }, row.name, 'first-private-value', 'oauth-token', null)
    expect(fixture.state.row).toMatchObject({ status: 'fulfilled', configuration: null, delivery_claim_id: null, delivery_claim_expires_at: null })
    await expect(fulfillSecret(port, requestId, 'third-private-value')).rejects.toThrow('já foi concluído')
    expect(mocks.deliver).toHaveBeenCalledTimes(1)
  })
  it('atomically refuses a second configured submission and prevents dismissal during credential lookup', async () => {
    const configuration = { kind: 'supabase-smtp' as const, provider: 'resend' as const, senderEmail: 'account@example.test', senderName: 'Example' }
    const fixture = configuredFixture(configuration); const port = secretRequestStore(fixture.client, 'owner', projectId)
    let finishCredentials: ((value: { projectRef: string; token: string }) => void) | undefined
    const credentials = new Promise<{ projectRef: string; token: string }>((resolve) => { finishCredentials = resolve })
    mocks.credentials.mockReturnValueOnce(credentials)
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({})).mockResolvedValueOnce(Response.json({
      smtp_host: 'smtp.resend.com', smtp_port: '465', smtp_user: 'resend', smtp_admin_email: configuration.senderEmail, smtp_sender_name: configuration.senderName,
    }))
    const first = fulfillSecret(port, requestId, 'first-private-value')
    await vi.waitFor(() => expect(mocks.credentials).toHaveBeenCalledTimes(1))
    await expect(fulfillSecret(port, requestId, 'second-private-value')).rejects.toThrow('já está sendo enviado')
    await expect(port.dismiss(requestId)).rejects.toThrow('está sendo enviado')
    expect(fixture.state.row).not.toBeNull()
    expect(globalThis.fetch).not.toHaveBeenCalled()
    finishCredentials?.({ projectRef: 'projectref', token: 'oauth-token' })
    await first
    expect(fixture.state.row).toMatchObject({ status: 'fulfilled', delivery_claim_id: null, delivery_claim_expires_at: null, configuration })
    expect(fixture.calls.filter((call) => call.table === 'audit_logs')).toHaveLength(1)
    await expect(fulfillSecret(port, requestId, 'third-private-value')).rejects.toThrow('já foi concluído')
    expect(globalThis.fetch).toHaveBeenCalledTimes(2)
    await port.dismiss(requestId)
    expect(fixture.state.row).toBeNull()
    expect(JSON.stringify(fixture.calls)).not.toMatch(/first-private-value|second-private-value|third-private-value|oauth-token/)
  })
  it('recovers expired leases but stale workers cannot deliver, confirm or release a newer claim', async () => {
    const configuration = { kind: 'supabase-user-password' as const, userId: requestId }
    const fixture = configuredFixture(configuration); const port = secretRequestStore(fixture.client, 'owner', projectId)
    const configured = { ...record, configuration }
    const first = await port.claim(configured)
    if (fixture.state.row) fixture.state.row.delivery_claim_expires_at = new Date(Date.now() - 1).toISOString()
    const second = await port.claim(configured)
    expect(second.id).not.toBe(first.id)
    await port.release(configured, first)
    expect(fixture.state.row?.delivery_claim_id).toBe(second.id)
    await expect(port.fulfill(configured, first)).rejects.toThrow('Confirmação não persistida')
    await expect(port.deliver(configured, { target: 'supabase', environment: 'development', targetRef: 'projectref', accountId }, 'private-value', first)).rejects.toThrow('reserva deste envio expirou')
    expect(mocks.credentials).not.toHaveBeenCalled()
    expect(fixture.state.row).toMatchObject({ status: 'pending', delivery_claim_id: second.id, configuration })
    await port.release(configured, second)
    expect(fixture.state.row).toMatchObject({ status: 'pending', delivery_claim_id: null, delivery_claim_expires_at: null, configuration })
  })
  it('refuses dispatch without enough lease time and refuses stale delivery after expired-request dismissal', async () => {
    const configuration = { kind: 'supabase-user-password' as const, userId: requestId }
    const fixture = configuredFixture(configuration); const port = secretRequestStore(fixture.client, 'owner', projectId)
    const configured = { ...record, configuration }; const claim = await port.claim(configured)
    const binding = { target: 'supabase' as const, environment: 'development' as const, targetRef: 'projectref', accountId }
    if (fixture.state.row) fixture.state.row.delivery_claim_expires_at = new Date(Date.now() + 19_000).toISOString()
    await expect(port.deliver(configured, binding, 'private-value', claim)).rejects.toThrow('reserva deste envio expirou')
    await expect(port.dismiss(requestId)).rejects.toThrow('está sendo enviado')
    if (fixture.state.row) fixture.state.row.delivery_claim_expires_at = new Date(Date.now() - 1).toISOString()
    await port.dismiss(requestId)
    await expect(port.deliver(configured, binding, 'private-value', claim)).rejects.toThrow('reserva deste envio expirou')
    expect(mocks.credentials).not.toHaveBeenCalled()
  })
  it('rechecks the lease after credential I/O, before the first provider request', async () => {
    const configuration = { kind: 'supabase-user-password' as const, userId: requestId }
    const fixture = configuredFixture(configuration); const port = secretRequestStore(fixture.client, 'owner', projectId)
    mocks.credentials.mockImplementation(async () => {
      if (fixture.state.row) fixture.state.row.delivery_claim_expires_at = new Date(Date.now() - 1).toISOString()
      return { projectRef: 'projectref', token: 'oauth-token' }
    })
    const fetcher = vi.spyOn(globalThis, 'fetch')
    await expect(fulfillSecret(port, requestId, 'private-value')).rejects.toThrow('reserva deste envio expirou')
    expect(fetcher).not.toHaveBeenCalled()
    expect(fixture.state.row).toMatchObject({ status: 'pending', delivery_claim_id: null, delivery_claim_expires_at: null, configuration })
  })
  it('configures SMTP through the management API, stores only intent and rechecks ownership for both requests', async () => {
    const configuration = { kind: 'supabase-smtp' as const, provider: 'resend' as const, senderEmail: 'account@example.test', senderName: 'Example' }
    const configuredRow = { ...row, configuration }
    const fixture = clientFixture((call) => call.table === 'secret_requests' && call.method === 'select' ? { data: call.filters.some(([key]) => key === 'id') ? configuredRow : [configuredRow], error: null } : undefined)
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({ smtp_pass: 'private-value' })).mockResolvedValueOnce(Response.json({
      smtp_host: 'smtp.resend.com', smtp_port: '465', smtp_user: 'resend', smtp_admin_email: configuration.senderEmail, smtp_sender_name: configuration.senderName, smtp_pass: 'private-value',
    }))
    const port = secretRequestStore(fixture.client, 'owner', projectId)
    await fulfillSecret(port, requestId, 'private-value')
    expect(fetcher.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      ['https://api.supabase.com/v1/projects/projectref/config/auth', 'PATCH'], ['https://api.supabase.com/v1/projects/projectref/config/auth', 'GET'],
    ])
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error', cache: 'no-store', headers: { Authorization: 'Bearer oauth-token' } })
    expect(mocks.credentials).toHaveBeenCalledTimes(2)
    expect(mocks.deliver).not.toHaveBeenCalled()
    expect(fixture.calls.find((call) => call.table === 'audit_logs')?.payload).toMatchObject({ metadata: { configuration } })
    expect(fixture.calls.find((call) => call.method === 'update' && JSON.stringify(call.payload).includes('fulfilled'))?.payload).toMatchObject({ status: 'fulfilled', delivery_claim_id: null, delivery_claim_expires_at: null })
    await port.insert([{ ...record, description: row.description, target: 'supabase', environment: 'development', targetRef: 'projectref', accountId, configuration }])
    expect(fixture.calls.at(-1)?.payload).toMatchObject([{ configuration }])
    expect(JSON.stringify(fixture.calls)).not.toMatch(/private-value|oauth-token|smtp_pass/)
  })
  it('sets only a development user password using the private service key and never stores or returns the value', async () => {
    const userId = '44444444-4444-4444-8444-444444444444'
    const configuration = { kind: 'supabase-user-password' as const, userId }
    const fixture = clientFixture((call) => call.table === 'secret_requests' && call.method === 'select' ? { data: { ...row, configuration }, error: null } : undefined)
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json([{ name: 'service_role', api_key: 'server-admin-key' }]))
      .mockResolvedValueOnce(Response.json({ id: userId, password: 'private-value' }))
    await fulfillSecret(secretRequestStore(fixture.client, 'owner', projectId), requestId, 'private-value')
    expect(fetcher.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      ['https://api.supabase.com/v1/projects/projectref/api-keys', 'GET'], [`https://projectref.supabase.co/auth/v1/admin/users/${userId}`, 'PUT'],
    ])
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({ body: JSON.stringify({ password: 'private-value' }), headers: { Authorization: 'Bearer server-admin-key', apikey: 'server-admin-key' } })
    expect(mocks.credentials).toHaveBeenCalledTimes(3)
    expect(JSON.stringify(fixture.calls)).not.toMatch(/private-value|server-admin-key|oauth-token/)
    expect(mocks.deliver).not.toHaveBeenCalled()
  })
  it.each(['account', 'environment', 'owner'])('refuses a %s change between SMTP update and readback and leaves the request pending', async (change) => {
    const configuration = { kind: 'supabase-smtp' as const, provider: 'resend' as const, senderEmail: 'account@example.test', senderName: 'Example' }
    let dispatched = false
    const fixture = clientFixture((call) => {
      if (call.table === 'secret_requests' && call.method === 'select') return { data: { ...row, configuration }, error: null }
      if (dispatched && call.table === 'projects' && change === 'account') return { data: { ...project, supabase_account_id: 'foreign' }, error: null }
      if (dispatched && call.table === 'projects' && change === 'owner') return { data: null, error: null }
      return undefined
    })
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      dispatched = true
      if (change === 'environment') mocks.environment.mockResolvedValue({ project_ref: 'projectref', environment: 'production', source: 'supremo_provisioned' })
      return Response.json({})
    })
    await expect(fulfillSecret(secretRequestStore(fixture.client, 'owner', projectId), requestId, 'private-value')).rejects.toThrow()
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fixture.calls.some((call) => call.method === 'update' && JSON.stringify(call.payload).includes('fulfilled'))).toBe(false)
  })
  it('refuses account revocation after private key lookup, before changing the password', async () => {
    const configuration = { kind: 'supabase-user-password' as const, userId: '44444444-4444-4444-8444-444444444444' }
    let revoked = false
    const fixture = clientFixture((call) => {
      if (call.table === 'secret_requests' && call.method === 'select') return { data: { ...row, configuration }, error: null }
      if (revoked && call.table === 'supabase_accounts') return { data: null, error: null }
      return undefined
    })
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { revoked = true; return Response.json([{ name: 'service_role', api_key: 'server-admin-key' }]) })
    await expect(fulfillSecret(secretRequestStore(fixture.client, 'owner', projectId), requestId, 'private-value')).rejects.toThrow('não encontrada ou não autorizada')
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fixture.calls.some((call) => call.method === 'update' && JSON.stringify(call.payload).includes('fulfilled'))).toBe(false)
  })
  it('fails closed on a configured request audit failure or private credentials bound to another project', async () => {
    const configuration = { kind: 'supabase-smtp' as const, provider: 'resend' as const, senderEmail: 'account@example.test', senderName: 'Example' }
    const make = (auditFailure: boolean) => clientFixture((call) => {
      if (call.table === 'secret_requests' && call.method === 'select') return { data: { ...row, configuration }, error: null }
      if (call.table === 'audit_logs' && auditFailure) return { data: null, error: { message: 'private-value' } }
      return undefined
    })
    const fetcher = vi.spyOn(globalThis, 'fetch')
    await expect(fulfillSecret(secretRequestStore(make(true).client, 'owner', projectId), requestId, 'private-value')).rejects.toThrow('valor ainda não foi enviado')
    mocks.credentials.mockResolvedValue({ projectRef: 'foreign', token: 'oauth-token' })
    await expect(fulfillSecret(secretRequestStore(make(false).client, 'owner', projectId), requestId, 'private-value')).rejects.toThrow('vínculo Supabase mudou')
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('filters project and provider accounts by owner and refuses missing/foreign ownership', async () => {
    const fixture = clientFixture()
    const port = secretRequestStore(fixture.client, 'owner', projectId)
    await port.authorize(); await port.resolve({ target: 'supabase', environment: 'development' })
    for (const call of fixture.calls.filter((item) => ['projects', 'supabase_accounts'].includes(item.table))) expect(call.filters).toContainEqual(['user_id', 'owner'])
    expect(fixture.calls[0]?.filters).toContainEqual(['id', projectId])
    for (const table of ['projects', 'supabase_accounts']) {
      const missing = clientFixture((call) => call.table === table ? { data: null, error: null } : undefined)
      await expect(secretRequestStore(missing.client, 'owner', projectId).resolve({ target: 'supabase', environment: 'development' })).rejects.toThrow(/não encontrad/)
      expect(mocks.credentials).not.toHaveBeenCalled()
    }
  })
  it('uses owner/project/request filters for reads, writes, dismissal and confirmation; inserts no values', async () => {
    const { client, calls } = clientFixture(); const port = secretRequestStore(client, 'owner', projectId)
    await port.list(); await port.find(requestId); await port.dismiss(requestId); await port.fulfill(record, claim)
    for (const call of calls) { expect(call.filters).toContainEqual(['project_id', projectId]); expect(call.filters).toContainEqual(['user_id', 'owner']) }
    for (const call of calls.slice(1)) expect(call.filters).toContainEqual(['id', requestId])
    expect(calls[0]?.limit).toBe(101)
    await port.insert([{ name: row.name, description: row.description, target: 'supabase', environment: 'development', targetRef: 'projectref', accountId }])
    expect(calls.at(-1)).toMatchObject({ method: 'upsert', options: { ignoreDuplicates: true }, payload: [{ project_id: projectId, user_id: 'owner', target_ref: 'projectref', target_account_id: accountId }] })
    expect(JSON.stringify(calls)).not.toMatch(/private-value|oauth-token/)
  })
  it('delivers Supabase using fresh owner credentials and rechecks binding immediately before provider call', async () => {
    const { client, calls } = clientFixture()
    await fulfillSecret(secretRequestStore(client, 'owner', projectId), requestId, 'private-value')
    expect(mocks.project).toHaveBeenCalledWith('owner', projectId)
    expect(mocks.credentials).toHaveBeenCalledWith('owner', project)
    expect(mocks.deliver).toHaveBeenCalledWith({ target: 'supabase', environment: 'development', targetRef: 'projectref', accountId }, row.name, 'private-value', 'oauth-token', null)
    expect(calls.filter((call) => call.table === 'projects')).toHaveLength(3)
    const audit = calls.find((call) => call.table === 'audit_logs')
    expect(audit?.payload).toMatchObject({ user_id: 'owner', metadata: { requestId, name: row.name, target: 'supabase', environment: 'development', targetRef: 'projectref' } })
    expect(JSON.stringify(calls)).not.toMatch(/private-value|oauth-token/)
  })
  it('refuses a relink discovered during credential resolution or immediately before dispatch', async () => {
    mocks.project.mockResolvedValue({ ...project, supabase_project_ref: 'foreign' })
    await expect(fulfillSecret(secretRequestStore(clientFixture().client, 'owner', projectId), requestId, 'private-value')).rejects.toThrow(/vínculo/)
    expect(mocks.deliver).not.toHaveBeenCalled()
    mocks.project.mockResolvedValue(project)
    let projectReads = 0
    const changed = clientFixture((call) => call.table === 'projects' && ++projectReads === 3 ? { data: { ...project, supabase_account_id: 'foreign-account' }, error: null } : undefined)
    await expect(fulfillSecret(secretRequestStore(changed.client, 'owner', projectId), requestId, 'private-value')).rejects.toThrow(/destino mudou/)
    expect(mocks.deliver).not.toHaveBeenCalled()
  })
  it('uses Vercel owner credentials and preserves one requested environment', async () => {
    const vercelRecord: SecretRequestRecord = { ...record, target: 'vercel', environment: 'preview', targetRef: 'vercelproject' }
    const { client, calls } = clientFixture()
    const port = secretRequestStore(client, 'owner', projectId)
    const binding = await port.resolve({ target: 'vercel', environment: 'preview' })
    await port.deliver(vercelRecord, binding, 'private-value', claim)
    expect(mocks.deliver).toHaveBeenCalledWith(binding, row.name, 'private-value', 'vercel-token', 'team')
    for (const call of calls.filter((item) => item.table === 'vercel_accounts')) expect(call.filters).toContainEqual(['user_id', 'owner'])
    expect(mocks.environment).not.toHaveBeenCalled()
  })
  it.each(['list', 'find', 'dismiss', 'fulfill', 'insert', 'audit'] as const)('propagates %s persistence errors instead of falsely acknowledging success', async (operation) => {
    const { client } = clientFixture((call) => call.table !== 'projects' && !call.table.endsWith('_accounts') ? { data: null, error: { message: 'private-value' } } : undefined)
    const port = secretRequestStore(client, 'owner', projectId)
    const promise = operation === 'list' ? port.list() : operation === 'find' ? port.find(requestId) : operation === 'dismiss' ? port.dismiss(requestId) : operation === 'fulfill' ? port.fulfill(record, claim) : operation === 'audit' ? port.audit(record) : port.insert([{ name: row.name, description: row.description, target: 'supabase', environment: 'development', targetRef: 'projectref', accountId }])
    await expect(promise).rejects.toThrow()
    await expect(promise).rejects.not.toThrow('private-value')
  })
  it.each([
    ['42703', 'schema_unavailable'],
    ['42501', 'access_denied'],
    ['PGRST003', 'storage_unavailable'],
  ])('reports %s accurately when project ownership succeeds but secret storage is unavailable', async (code, expectedCode) => {
    const fixture = clientFixture((call) => call.table === 'secret_requests' ? { data: null, error: { code, message: 'private-value' } } : undefined)
    const port = secretRequestStore(fixture.client, 'owner', projectId)
    await port.authorize()
    await expect(port.list()).rejects.toMatchObject({ code: expectedCode })
    expect(fixture.calls.filter((call) => call.table === 'secret_requests')).toHaveLength(1)
    expect(mocks.deliver).not.toHaveBeenCalled()
    expect(mocks.credentials).not.toHaveBeenCalled()
  })
  it('does not deliver after a Vercel account is removed', async () => {
    const { client } = clientFixture((call) => call.table === 'vercel_accounts' ? { data: null, error: null } : undefined)
    const vercelRecord: SecretRequestRecord = { ...record, target: 'vercel', environment: 'preview', targetRef: 'vercelproject' }
    await expect(secretRequestStore(client, 'owner', projectId).deliver(vercelRecord, { target: 'vercel', environment: 'preview', targetRef: 'vercelproject', accountId }, 'private-value', claim)).rejects.toThrow('Conta Vercel não autorizada')
    expect(mocks.deliver).not.toHaveBeenCalled()
  })
})
