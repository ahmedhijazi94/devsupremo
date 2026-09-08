import { createClient } from '@supabase/supabase-js'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ client: vi.fn() }))
vi.mock('@/lib/supabase/admin', () => ({ createServiceClient: mocks.client }))
import { readIntegrationMeta, writeIntegrationMeta } from './repository'

const projectId = '11111111-1111-4111-8111-111111111111'

/** Real PostgREST query builder; only the HTTP/database boundary is simulated. */
function database(initialState: string | null, readResult: 'ok' | 'missing' | 'error' = 'ok') {
  const row = { id: projectId, github_merge_mode: 'supremo_managed', protection_level: 'supremo_managed', integration_state: initialState }
  const updates: URL[] = []
  let beforeUpdate: (() => void) | undefined
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    if (init?.method !== 'PATCH') {
      if (readResult === 'missing') return Response.json(null)
      if (readResult === 'error') return Response.json({ message: 'Database unavailable' }, { status: 400 })
      return Response.json({ ...row })
    }
    updates.push(url)
    beforeUpdate?.()
    const expected = url.searchParams.get('integration_state')
    const matches = expected === null || (expected === 'is.null' ? row.integration_state === null : expected === `eq.${row.integration_state}`)
    if (url.searchParams.get('id') === `eq.${row.id}` && matches) Object.assign(row, JSON.parse(String(init.body)))
    return new Response(null, { status: 204 })
  }
  mocks.client.mockReturnValue(createClient('https://supabase.example.test', 'test-service-key', {
    global: { fetch: fetcher }, auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  }))
  return { row, updates, beforeUpdate: (callback: () => void) => { beforeUpdate = callback } }
}

beforeEach(() => vi.resetAllMocks())

describe('integration metadata conditional update', () => {
  it.each(['missing', 'error'] as const)('rejects %s configuration in strict mode instead of selecting a fallback', async (result) => {
    database('ci_running', result)
    await expect(readIntegrationMeta(projectId, { strict: true })).rejects.toThrow('Configuração de integração indisponível.')
    await expect(readIntegrationMeta(projectId)).resolves.toEqual({ mergeMode: null, protectionLevel: null, integrationState: null })
  })

  it('rejects a configuration read exception in strict mode and retains legacy best-effort behavior', async () => {
    mocks.client.mockImplementation(() => { throw new Error('Database unavailable') })
    await expect(readIntegrationMeta(projectId, { strict: true })).rejects.toThrow('Configuração de integração indisponível.')
    await expect(readIntegrationMeta(projectId)).resolves.toEqual({ mergeMode: null, protectionLevel: null, integrationState: null })
  })

  it.each(['ci_running', null])('atomically advances the unchanged state %s, with a project-scoped predicate', async (state) => {
    const store = database(state)
    const observed = await readIntegrationMeta(projectId, { strict: true })
    await writeIntegrationMeta(projectId, { integration_state: 'merged' }, { expectedState: observed.integrationState })
    expect(store.row.integration_state).toBe('merged')
    expect(store.updates[0]?.searchParams.get('id')).toBe(`eq.${projectId}`)
    expect(store.updates[0]?.searchParams.get('integration_state')).toBe(state === null ? 'is.null' : `eq.${state}`)
  })

  it.each(['security_blocked', null])('preserves a merge that lands after the final read and before the stale %s UPDATE', async (state) => {
    const store = database(state)
    const observed = await readIntegrationMeta(projectId)
    // This happens inside the database request, after all application reads.
    store.beforeUpdate(() => { store.row.integration_state = 'merged' })
    await writeIntegrationMeta(projectId, { integration_state: 'ci_running' }, { expectedState: observed.integrationState })
    expect(store.updates).toHaveLength(1)
    expect(store.row.integration_state).toBe('merged')
    expect(store.updates[0]?.searchParams.get('integration_state')).toBe(state === null ? 'is.null' : `eq.${state}`)
  })

  it('preserves the existing unconditional adapter contract for other callers', async () => {
    const store = database('ci_running')
    await writeIntegrationMeta(projectId, { integration_state: 'merged', protection_level: 'github_native' })
    expect(store.row).toMatchObject({ integration_state: 'merged', protection_level: 'github_native' })
    expect(store.updates[0]?.searchParams.get('integration_state')).toBeNull()
  })
})
