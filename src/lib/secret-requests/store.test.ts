import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
const mocks = vi.hoisted(() => ({ environment: vi.fn(), project: vi.fn(), credentials: vi.fn(), decrypt: vi.fn(), deliver: vi.fn() }))
vi.mock('@/lib/database-environment/store', () => ({ readEnvironment: mocks.environment }))
vi.mock('@/lib/projects/repository', () => ({ getProject: mocks.project, getSupabaseCredentials: mocks.credentials }))
vi.mock('@/lib/crypto', () => ({ decryptToken: mocks.decrypt }))
vi.mock('./provider', () => ({ deliverSecret: mocks.deliver }))
import { secretRequestStore } from './store'
import { fulfillSecret } from './service'
import type { SecretRequestRecord } from './policy'
const projectId = '11111111-1111-4111-8111-111111111111'
const requestId = '22222222-2222-4222-8222-222222222222'
const accountId = '33333333-3333-4333-8333-333333333333'
const project = { id: projectId, supabase_account_id: accountId, supabase_project_ref: 'projectref', vercel_account_id: accountId, vercel_project_id: 'vercelproject' }
const row = { id: requestId, name: 'PAYMENT_API_KEY', description: 'Backend', target: 'supabase', environment: 'development', target_ref: 'projectref', target_account_id: accountId, status: 'pending' }
const record: SecretRequestRecord = { id: requestId, name: row.name, description: row.description, target: 'supabase', environment: 'development', targetRef: 'projectref', accountId, status: 'pending' }
interface Call { table: string; method: string; payload?: unknown; options?: unknown; filters: Array<[string, unknown]>; columns?: string; limit?: number }
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
beforeEach(() => {
  vi.resetAllMocks()
  mocks.environment.mockResolvedValue({ project_ref: 'projectref', environment: 'development', source: 'supremo_provisioned' })
  mocks.project.mockResolvedValue(project)
  mocks.credentials.mockResolvedValue({ projectRef: 'projectref', token: 'oauth-token' })
  mocks.decrypt.mockReturnValue('vercel-token')
})
describe('owner scoped secret request store', () => {
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
    await port.list(); await port.find(requestId); await port.dismiss(requestId); await port.fulfill(record)
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
    await port.deliver(vercelRecord, binding, 'private-value')
    expect(mocks.deliver).toHaveBeenCalledWith(binding, row.name, 'private-value', 'vercel-token', 'team')
    for (const call of calls.filter((item) => item.table === 'vercel_accounts')) expect(call.filters).toContainEqual(['user_id', 'owner'])
    expect(mocks.environment).not.toHaveBeenCalled()
  })
  it.each(['list', 'find', 'dismiss', 'fulfill', 'insert', 'audit'] as const)('propagates %s persistence errors instead of falsely acknowledging success', async (operation) => {
    const { client } = clientFixture((call) => call.table !== 'projects' && !call.table.endsWith('_accounts') ? { data: null, error: { message: 'private-value' } } : undefined)
    const port = secretRequestStore(client, 'owner', projectId)
    const promise = operation === 'list' ? port.list() : operation === 'find' ? port.find(requestId) : operation === 'dismiss' ? port.dismiss(requestId) : operation === 'fulfill' ? port.fulfill(record) : operation === 'audit' ? port.audit(record) : port.insert([{ name: row.name, description: row.description, target: 'supabase', environment: 'development', targetRef: 'projectref', accountId }])
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
    await expect(secretRequestStore(client, 'owner', projectId).deliver(vercelRecord, { target: 'vercel', environment: 'preview', targetRef: 'vercelproject', accountId }, 'private-value')).rejects.toThrow('Conta Vercel não autorizada')
    expect(mocks.deliver).not.toHaveBeenCalled()
  })
})
