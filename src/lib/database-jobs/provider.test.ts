import { afterEach, describe, expect, it, vi } from 'vitest'
import { JobsError, supabaseJobsProvider } from './provider'

afterEach(() => vi.unstubAllGlobals())
const credentials = { projectRef: 'project-fixture', token: 'private-provider-fixture' }
describe('jobs fixed Management transport', () => {
  it('refreshes credentials per dispatch, bounds reads and forbids HTTP redirects', async () => {
    const resolve = vi.fn(async () => credentials)
    vi.stubGlobal('fetch', vi.fn(async () => Response.json([{ ready: true }])))
    const provider = supabaseJobsProvider(resolve)
    await provider.query('SELECT 1', { readOnly: true })
    await provider.query('BEGIN; SELECT 1; COMMIT;', { readOnly: false })
    expect(resolve.mock.calls).toEqual([[true], [false]])
    const requests = vi.mocked(fetch).mock.calls
    expect(requests[0]![0]).toBe('https://api.supabase.com/v1/projects/project-fixture/database/query')
    expect(requests[0]![1]).toMatchObject({ redirect: 'error', cache: 'no-store', method: 'POST', signal: expect.any(AbortSignal) })
    expect(String(requests[0]![1]!.body)).toContain('BEGIN READ ONLY;')
    expect(String(requests[0]![1]!.body)).toContain('statement_timeout')
    expect(JSON.parse(String(requests[1]![1]!.body))).toEqual({ query: 'BEGIN; SELECT 1; COMMIT;' })
  })
  it('does not dispatch when authorization or ref validation fails', async () => {
    vi.stubGlobal('fetch', vi.fn())
    await expect(supabaseJobsProvider(async () => { throw new JobsError('Dispositivo revogado', 401) }).query('SELECT 1', { readOnly: true })).rejects.toMatchObject({ status: 401 })
    await expect(supabaseJobsProvider(async () => ({ ...credentials, projectRef: 'ref/../../other' })).query('SELECT 1', { readOnly: true })).rejects.toThrow('Vínculo')
    expect(fetch).not.toHaveBeenCalled()
  })
  it.each([403, 404, 429, 500])('sanitizes refusal HTTP %s without fallback', async (status) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(credentials.token, { status })))
    const error = await supabaseJobsProvider(async () => credentials).query('SELECT 1', { readOnly: true }).catch((value: unknown) => value)
    expect(error).toMatchObject({ status: status === 429 ? 429 : 502 })
    expect(String(error)).toContain(`HTTP ${status}`)
    expect(String(error)).not.toContain(credentials.token)
    expect(fetch).toHaveBeenCalledOnce()
  })
  it('reports ambiguous network write failure without promising rollback', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error(credentials.token) }))
    await expect(supabaseJobsProvider(async () => credentials).query('BEGIN; SELECT 1; COMMIT;', { readOnly: false })).rejects.toMatchObject({ status: 504, message: expect.stringContaining('Consulte jobs list') })
  })
  it.each([{}, '{bad-json', 'x'.repeat(512001)])('rejects malformed or oversized result without provider details', async (body) => {
    vi.stubGlobal('fetch', vi.fn(async () => typeof body === 'string' ? new Response(body) : Response.json(body)))
    await expect(supabaseJobsProvider(async () => credentials).query('SELECT 1', { readOnly: true })).rejects.toMatchObject({ status: 502, message: expect.stringContaining('não confirmado') })
  })
})
