import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { supabaseStorageProvider } from './provider'

const ref = 'projectref', credential = { projectRef: ref, token: 'private-management-fixture' }, storageKey = 'private-storage-fixture'
const management = `https://api.supabase.com/v1/projects/${ref}/api-keys`, origin = `https://${ref}.supabase.co`
const fetcher = vi.fn<typeof fetch>()
beforeEach(() => { vi.resetAllMocks(); vi.stubGlobal('fetch', fetcher) })
afterEach(() => vi.unstubAllGlobals())
function responses(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  fetcher.mockImplementation(async (input, init) => String(input) === management ? Response.json([{ name: 'service_role', api_key: storageKey }]) : handler(String(input), init))
}
describe('Storage transport at its real SDK boundary', () => {
  it('reauthorizes before and after SDK dispatch and projects only allowed metadata', async () => {
    const resolve = vi.fn(async () => credential)
    responses(() => Response.json([{ id: 'documents', name: 'documents', public: false, file_size_limit: 100, allowed_mime_types: ['text/plain'], created_at: '2026-10-05', private: 'hidden' }]))
    const provider = supabaseStorageProvider(resolve)
    expect(await provider.buckets()).toEqual([{ id: 'documents', name: 'documents', public: false, file_size_limit: 100, allowed_mime_types: ['text/plain'], created_at: '2026-10-05' }])
    expect(resolve).toHaveBeenCalledTimes(4)
    const call = fetcher.mock.calls[1]!
    expect(String(call[0])).toBe(`${origin}/storage/v1/bucket`)
    expect(call[1]).toMatchObject({ redirect: 'error', cache: 'no-store' })
    expect(call[1]?.signal).toBeInstanceOf(AbortSignal)
  })
  it('stops revocation before object dispatch and sanitizes SDK errors', async () => {
    const resolve = vi.fn().mockResolvedValueOnce(credential).mockResolvedValueOnce(credential).mockRejectedValue(new Error('Authorization revoked'))
    responses(() => { throw new Error('must not dispatch') })
    await expect(supabaseStorageProvider(resolve).upload('documents', 'test.txt', 'dGVzdA==', 'text/plain')).rejects.toThrow()
    expect(fetcher).toHaveBeenCalledOnce()
    responses(() => Response.json({ message: `failure ${storageKey}` }, { status: 403 }))
    await expect(supabaseStorageProvider(async () => credential).buckets()).rejects.toThrow('não confirmou')
  })
  it('proves upload bytes and type; existence alone cannot confirm the requested content', async () => {
    const provider = supabaseStorageProvider(async () => credential)
    responses(() => new Response('test', { headers: { 'content-type': 'text/plain; charset=utf-8' } }))
    expect(await provider.verifyUpload('documents', 'folder/test.txt', 'dGVzdA==', 'text/plain')).toBe(true)
    expect(String(fetcher.mock.calls[1]![0])).toBe(`${origin}/storage/v1/object/authenticated/documents/folder/test.txt`)
    responses(() => new Response('evil', { headers: { 'content-type': 'text/plain' } }))
    expect(await provider.verifyUpload('documents', 'test.txt', 'dGVzdA==', 'text/plain')).toBe(false)
    responses(() => new Response('test', { headers: { 'content-type': 'text/html' } }))
    expect(await provider.verifyUpload('documents', 'test.txt', 'dGVzdA==', 'text/plain')).toBe(false)
    responses(() => new Response('too large', { headers: { 'content-type': 'text/plain' } }))
    expect(await provider.verifyUpload('documents', 'test.txt', 'dGVzdA==', 'text/plain')).toBe(false)
    responses(() => new Response('test', { headers: { 'content-type': 'text/plain', 'content-length': '1000000' } }))
    expect(await provider.verifyUpload('documents', 'test.txt', 'dGVzdA==', 'text/plain')).toBe(false)
  })
  it('uses no upsert, only requested delete paths and exact signed resource URL', async () => {
    const provider = supabaseStorageProvider(async () => credential)
    responses((url, init) => {
      if (url.includes('/object/sign/')) return Response.json({ signedURL: '/object/sign/documents/folder/test.txt?token=download-fixture' })
      if (init?.method === 'DELETE') return Response.json([])
      return Response.json({ Id: 'object-id', Key: 'documents/folder/test.txt' })
    })
    await provider.upload('documents', 'folder/test.txt', 'dGVzdA==', 'text/plain')
    expect(new Headers(fetcher.mock.calls[1]![1]?.headers).get('x-upsert')).toBe('false')
    await provider.remove('documents', ['folder/test.txt'])
    expect(fetcher.mock.calls[3]![1]?.body).toBe(JSON.stringify({ prefixes: ['folder/test.txt'] }))
    expect(await provider.download('documents', 'folder/test.txt')).toContain('/object/sign/documents/folder/test.txt?token=download-fixture')
    responses(() => Response.json({ signedURL: '/object/sign/other/private.txt?token=private' }))
    await expect(provider.download('documents', 'folder/test.txt')).rejects.toThrow('não corresponde')
  })
  it('rejects account/ref change during private key lookup and does not return an API key', async () => {
    responses(() => Response.json([]))
    const resolve = vi.fn().mockResolvedValueOnce(credential).mockResolvedValueOnce({ ...credential, projectRef: 'otherproject' })
    await expect(supabaseStorageProvider(resolve).buckets()).rejects.toThrow('mudou')
    expect(fetcher).toHaveBeenCalledOnce()
    fetcher.mockResolvedValueOnce(new Response('private failure', { status: 401 }))
    await expect(supabaseStorageProvider(async () => credential).buckets()).rejects.toThrow('autorizar')
  })
  it('does not accept metadata if authorization changes after provider response', async () => {
    const resolve = vi.fn().mockResolvedValueOnce(credential).mockResolvedValueOnce(credential).mockResolvedValueOnce(credential).mockRejectedValueOnce(new Error('Revoked after dispatch'))
    responses(() => Response.json([]))
    await expect(supabaseStorageProvider(resolve).buckets()).rejects.toThrow()
  })
})
