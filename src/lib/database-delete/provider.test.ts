import { afterEach, describe, expect, it, vi } from 'vitest'
import { supabaseDeleteProvider } from './provider'

afterEach(() => vi.unstubAllGlobals())
describe('server-generated deletion transport', () => {
  it('reauthorizes every query and confines inspection to read-only transactions', async () => {
    const resolve = vi.fn().mockResolvedValue({ token: 'private-token', projectRef: 'owned-ref' })
    const fetch = vi.fn().mockResolvedValue(Response.json([{ snapshot: {} }]))
    vi.stubGlobal('fetch', fetch)
    const provider = supabaseDeleteProvider(resolve)
    await provider.query('SELECT 1', true)
    expect(fetch).toHaveBeenCalledWith('https://api.supabase.com/v1/projects/owned-ref/database/query', expect.objectContaining({ redirect: 'error', cache: 'no-store' }))
    expect(JSON.parse(fetch.mock.calls[0]![1].body).query).toContain('BEGIN READ ONLY')
    fetch.mockResolvedValue(Response.json([{ deletedCount: 1 }]))
    await provider.query('BEGIN; SELECT 2; COMMIT;', false)
    expect(JSON.parse(fetch.mock.calls[1]![1].body).query).toBe('BEGIN; SELECT 2; COMMIT;')
    expect(resolve).toHaveBeenCalledTimes(2)
  })
  it('rejects invalid refs and authorization loss before fetch', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    await expect(supabaseDeleteProvider(async () => ({ token: 'x', projectRef: '../../other' })).query('SELECT 1', true)).rejects.toThrow('Vínculo')
    await expect(supabaseDeleteProvider(async () => { throw new Error('revoked') }).query('SELECT 1', false)).rejects.toThrow('revoked')
    expect(fetch).not.toHaveBeenCalled()
  })
  it.each(['SUPREMO_DELETE_CHANGED', 'SUPREMO_DELETE_COUNT', 'SUPREMO_DELETE_DEPENDENCIES', 'untrusted private detail'])('returns only fixed diagnostics for %s', async detail => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ message: detail, password: 'secret' }, { status: 400 })))
    const provider = supabaseDeleteProvider(async () => ({ token: 'x', projectRef: 'ref' }))
    const error = await provider.query('SELECT 1', false).catch((value: unknown) => value)
    expect(error).toBeInstanceOf(Error)
    expect(String(error)).not.toContain('secret')
    expect(String(error)).not.toContain('private detail')
  })
  it('does not retry uncertain writes', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('network')); vi.stubGlobal('fetch', fetch)
    await expect(supabaseDeleteProvider(async () => ({ token: 'x', projectRef: 'ref' })).query('DELETE', false)).rejects.toThrow('não será repetido')
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('does not expose malformed error bodies or accept invalid success JSON', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('private-text', { status: 429 })); vi.stubGlobal('fetch', fetch)
    const provider = supabaseDeleteProvider(async () => ({ token: 'x', projectRef: 'ref' }))
    await expect(provider.query('query', false)).rejects.toMatchObject({ status: 429 })
    fetch.mockResolvedValue(new Response('invalid'))
    await expect(provider.query('query', false)).rejects.toThrow('Resposta do banco inválida')
  })
})
