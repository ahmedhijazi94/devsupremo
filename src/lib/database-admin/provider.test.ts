import { afterEach, expect, it, vi } from 'vitest'
import { supabaseAuthAdminProvider } from './provider'
afterEach(() => vi.unstubAllGlobals())
const resolve = async () => ({ projectRef: 'fixture-ref', token: 'server-only-token' })
it('bounds and hides provider errors including permission failures', async () => {
  const fetcher = vi.fn(async () => new Response('upstream secret', { status: 403 })); vi.stubGlobal('fetch', fetcher)
  const p = supabaseAuthAdminProvider(resolve, [])
  await expect(p.management('config/auth', 'GET')).rejects.toThrow(/HTTP 403/)
  fetcher.mockResolvedValue(new Response('upstream secret', { status: 500 }))
  await expect(p.management('config/auth', 'GET')).rejects.not.toThrow(/upstream secret/)
  fetcher.mockResolvedValue(new Response('x'.repeat(512001)))
  await expect(p.management('config/auth', 'GET')).rejects.toThrow(/limite/)
})
it('handles user creation/deletion and never falls back to a missing or different-project key', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json([{ name: 'service_role', api_key: 'admin-fixture' }]))
    .mockResolvedValueOnce(Response.json({ id: 'created-user' })); vi.stubGlobal('fetch', fetcher)
  const secrets: string[] = []
  const p = supabaseAuthAdminProvider(resolve, secrets)
  expect(await p.user('POST', null, { email: 'a@example.test' })).toEqual({ id: 'created-user' })
  expect(fetcher.mock.calls[1]?.[0]).toBe('https://fixture-ref.supabase.co/auth/v1/admin/users')
  expect(secrets).toContain('admin-fixture')
  fetcher.mockResolvedValueOnce(Response.json([{ name: 'service_role', api_key: 'admin-fixture' }])).mockResolvedValueOnce(new Response(null, { status: 204 }))
  expect(await p.user('DELETE', 'some-id')).toBeNull()
  fetcher.mockResolvedValueOnce(Response.json([]))
  await expect(p.user('DELETE', 'some-id')).rejects.toThrow(/indisponível/)
  const changing = vi.fn().mockResolvedValueOnce(await resolve()).mockResolvedValueOnce(await resolve()).mockResolvedValueOnce({ projectRef: 'foreign', token: 'fixture' })
  fetcher.mockResolvedValueOnce(Response.json([{ name: 'service_role', api_key: 'admin-fixture' }]))
  await expect(supabaseAuthAdminProvider(changing, []).user('DELETE', 'some-id')).rejects.toThrow(/mudou/)
})
