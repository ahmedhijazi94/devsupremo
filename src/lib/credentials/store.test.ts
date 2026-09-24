import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'
import { safeSecretFailure } from '@/lib/secret-requests/policy'
import { credentialStore } from './store'
import type { CredentialRecord } from './service'

const userId = '11111111-1111-4111-8111-111111111111'
const projectId = '22222222-2222-4222-8222-222222222222'
const credentialId = '33333333-3333-4333-8333-333333333333'
const requestId = '44444444-4444-4444-8444-444444444444'
const otherId = '55555555-5555-4555-8555-555555555555'
const encryptedValue = 'synthetic-encrypted-value-not-for-clients'
const metadata = { id: credentialId, name: 'RESEND_API_KEY', environment: 'development' as const, createdAt: '2026-09-24T10:00:00Z', updatedAt: '2026-09-24T10:00:00Z' }
const record: CredentialRecord = { ...metadata, userId, projectId, encryptedValue }
const row = { id: credentialId, name: metadata.name, environment: metadata.environment, created_at: metadata.createdAt, updated_at: metadata.updatedAt,
  user_id: userId, project_id: projectId, encrypted_value: encryptedValue, value: 'unwanted-private-field' }

interface Call {
  table: string
  method: 'select' | 'insert' | 'delete'
  columns?: string
  payload?: unknown
  filters: Array<[string, unknown]>
  limit?: number
  order?: { column: string; ascending: boolean }
}
interface Result { data: unknown; error: unknown }
function fixture(override?: (call: Call) => Result | undefined) {
  const calls: Call[] = []
  const from = (table: string) => {
    const call: Call = { table, method: 'select', filters: [] }
    const result = () => {
      calls.push(call)
      const custom = override?.(call)
      if (custom) return custom
      if (table === 'projects') return { data: { id: projectId }, error: null }
      if (call.method === 'select') return { data: call.filters.some(([key]) => key === 'id') ? row : [row], error: null }
      return { data: { id: credentialId }, error: null }
    }
    const chain = {
      select(columns: string) { call.columns = columns; return chain },
      eq(key: string, value: unknown) { call.filters.push([key, value]); return chain },
      order(column: string, options: { ascending: boolean }) { call.order = { column, ...options }; return chain },
      limit(value: number) { call.limit = value; return chain },
      insert(payload: unknown) { call.method = 'insert'; call.payload = payload; return chain },
      delete() { call.method = 'delete'; return chain },
      maybeSingle() { return Promise.resolve(result()) },
      then(resolve: (value: Result) => unknown, reject?: (reason: unknown) => unknown) { return Promise.resolve(result()).then(resolve, reject) },
    }
    return chain
  }
  return { client: { from } as unknown as SupabaseClient, calls }
}

describe('owner scoped encrypted credential store', () => {
  it('selects only safe metadata for listing and excludes extra private database fields from the result', async () => {
    const { client, calls } = fixture()
    const credentials = await credentialStore(client, userId, projectId).list()
    expect(credentials).toEqual([metadata])
    expect(calls).toEqual([{ table: 'project_credentials', method: 'select', columns: 'id,name,environment,created_at,updated_at',
      filters: [['user_id', userId], ['project_id', projectId]], order: { column: 'created_at', ascending: false }, limit: 1000 }])
    expect(calls[0]?.columns).not.toMatch(/encrypted_value|\*/)
    expect(JSON.stringify(credentials)).not.toMatch(/unwanted-private-field|synthetic-encrypted-value|user_id|project_id/)
  })

  it('loads ciphertext only for a private exact-ID lookup scoped to the owner and project', async () => {
    const { client, calls } = fixture()
    expect(await credentialStore(client, userId, projectId).find(credentialId)).toEqual(record)
    expect(calls).toEqual([{ table: 'project_credentials', method: 'select', columns: 'id,name,environment,created_at,updated_at,user_id,project_id,encrypted_value',
      filters: [['user_id', userId], ['project_id', projectId], ['id', credentialId]] }])
  })

  it('queries ownership with both trusted IDs and a minimal project selection', async () => {
    const { client, calls } = fixture()
    await credentialStore(client, userId, projectId).authorize()
    expect(calls).toEqual([{ table: 'projects', method: 'select', columns: 'id', filters: [['id', projectId], ['user_id', userId]] }])
  })

  it.each([null, { message: 'database-private-error' }])('rejects missing or failed project ownership without exposing backend details (%s)', async (error) => {
    const { client } = fixture((call) => call.table === 'projects' ? { data: null, error } : undefined)
    const promise = credentialStore(client, userId, projectId).authorize()
    await expect(promise).rejects.toThrow('Projeto não encontrado ou não autorizado.')
    await expect(promise).rejects.not.toThrow('database-private-error')
  })

  it('returns empty or missing records without inventing credentials', async () => {
    const { client } = fixture(() => ({ data: null, error: null }))
    const port = credentialStore(client, userId, projectId)
    expect(await port.list()).toEqual([])
    expect(await port.find(credentialId)).toBeNull()
  })

  it('inserts ciphertext with the bound scope and never spreads unknown or raw fields into persistence', async () => {
    const { client, calls } = fixture()
    const incoming = { ...record, value: 'unwanted-raw-value', raw: 'unwanted-raw-property' }
    await credentialStore(client, userId, projectId).insert(incoming)
    expect(calls).toEqual([{ table: 'project_credentials', method: 'insert', columns: 'id', filters: [], payload: {
      id: credentialId, user_id: userId, project_id: projectId, name: metadata.name, environment: metadata.environment,
      encrypted_value: encryptedValue, created_at: metadata.createdAt, updated_at: metadata.updatedAt,
    } }])
    expect(JSON.stringify(calls)).not.toMatch(/unwanted-raw/)
  })

  it.each(['userId', 'projectId'] as const)('refuses an insert for a different %s before issuing any database query', async (property) => {
    const { client, calls } = fixture()
    await expect(credentialStore(client, userId, projectId).insert({ ...record, [property]: otherId })).rejects.toThrow('Credencial fora do escopo do projeto.')
    expect(calls).toEqual([])
  })

  it('scopes removal to the exact credential, owner and project', async () => {
    const { client, calls } = fixture()
    await credentialStore(client, userId, projectId).remove(credentialId)
    expect(calls).toEqual([{ table: 'project_credentials', method: 'delete', filters: [['id', credentialId], ['user_id', userId], ['project_id', projectId]] }])
  })

  it.each(['list', 'find', 'insert', 'remove'] as const)('sanitizes a %s persistence failure instead of returning success or backend content', async (operation) => {
    const { client } = fixture(() => ({ data: row, error: { message: 'raw-value-leak', details: encryptedValue } }))
    const port = credentialStore(client, userId, projectId)
    const promise = operation === 'list' ? port.list() : operation === 'find' ? port.find(credentialId) : operation === 'insert' ? port.insert(record) : port.remove(credentialId)
    await expect(promise).rejects.toThrow('Não foi possível acessar o cofre do projeto.')
    await expect(promise).rejects.not.toThrow(/raw-value-leak|synthetic-encrypted-value/)
  })

  it('refuses to acknowledge an insert without a persisted row', async () => {
    const { client } = fixture(() => ({ data: null, error: null }))
    await expect(credentialStore(client, userId, projectId).insert(record)).rejects.toThrow('Não foi possível acessar o cofre do projeto.')
  })

  it('records only credential and request references in its owner/project audit trail', async () => {
    const { client, calls } = fixture()
    const port = credentialStore(client, userId, projectId)
    await port.audit('saved', credentialId, requestId)
    await port.audit('removed', credentialId)
    expect(calls.map((call) => call.payload)).toEqual([
      { user_id: userId, action: 'credential.save_requested', resource_type: 'project', resource_id: projectId, metadata: { credentialId, requestId }, ip_address: null },
      { user_id: userId, action: 'credential.removal_requested', resource_type: 'project', resource_id: projectId, metadata: { credentialId }, ip_address: null },
    ])
    expect(calls.every((call) => call.table === 'audit_logs')).toBe(true)
    expect(JSON.stringify(calls)).not.toContain(encryptedValue)
  })

  it('fails audit writes explicitly without exposing their private database error', async () => {
    const { client } = fixture(() => ({ data: null, error: { message: 'raw-value-leak' } }))
    const promise = credentialStore(client, userId, projectId).audit('used', credentialId, requestId)
    await expect(promise).rejects.toThrow('Não foi possível registrar a operação do cofre. Tente novamente.')
    await expect(promise).rejects.not.toThrow('raw-value-leak')
  })

  it('fails closed on malformed metadata and sends only the safe generic error across the action boundary', async () => {
    const { client } = fixture(() => ({ data: [{ ...row, environment: 'private-malformed-environment' }], error: null }))
    const outcome = await credentialStore(client, userId, projectId).list().then(() => ({ ok: true }), safeSecretFailure)
    expect(outcome).toHaveProperty('error')
    expect(JSON.stringify(outcome)).not.toMatch(/private-malformed-environment|unwanted-private-field|synthetic-encrypted-value/)
  })
})
