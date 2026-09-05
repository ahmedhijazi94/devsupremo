import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { provisionSupabase } from './provision'
vi.mock('@/lib/crypto', () => ({ decryptToken: () => 'test-token', encryptToken: () => 'encrypted' }))
const chain = { from: () => chain, select: () => chain, eq: () => chain, maybeSingle: async () => ({ data: { access_token_encrypted: 'x', org_slug: 'test' } }) }
const client = chain as unknown as SupabaseClient
const files = [{ path: 'supabase/migrations/002_second.sql', content: 'select 2;' }, { path: 'supabase/migrations/001_first.sql', content: 'select 1;' }]
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })
describe('banco preparado antes de finalizar provisionamento', () => {
  it('não aceita falha de migration como sucesso e não cria outro banco no retry', async () => {
    vi.useFakeTimers()
    const requests: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      requests.push(url)
      return url.endsWith('/database/query') ? new Response('', { status: 400 }) : Response.json({ status: 'ACTIVE_HEALTHY' })
    }))
    const pending = expect(provisionSupabase(client, 'user', 'account', 'app', files, { existingRef: 'existing', verifyDevelopment: async () => {} })).rejects.toThrow(/falha na migration/)
    await vi.advanceTimersByTimeAsync(5000)
    await pending
    expect(requests.every((url) => url.includes('/projects/existing'))).toBe(true)
  })
  it('banco que não ficou saudável permanece retomável, sem sucesso falso', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ status: 'COMING_UP' })))
    const pending = expect(provisionSupabase(client, 'user', 'account', 'app', files, { existingRef: 'existing', verifyDevelopment: async () => {} })).rejects.toThrow(/ainda em preparação/)
    await vi.advanceTimersByTimeAsync(120000)
    await pending
  })
  it('aplica todas as migrations em ordem e só então retorna sucesso', async () => {
    vi.useFakeTimers()
    const sql: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/database/query')) sql.push((JSON.parse(String(init?.body)) as { query: string }).query)
      return Response.json({ status: 'ACTIVE_HEALTHY' })
    }))
    const pending = provisionSupabase(client, 'user', 'account', 'app', files, { existingRef: 'existing', verifyDevelopment: async () => {} })
    await vi.advanceTimersByTimeAsync(5000)
    expect((await pending).projectRef).toBe('existing')
    expect(sql).toHaveLength(2)
    expect(sql[0]).toContain('select 1;')
    expect(sql[1]).toContain('select 2;')
  })
})

it('retry sem autoridade de ambiente nunca chega ao provedor', async () => {
  const request = vi.fn()
  vi.stubGlobal('fetch', request)
  await expect(provisionSupabase(client, 'user', 'account', 'app', files, { existingRef: 'unknown' })).rejects.toThrow(/classificação development/)
  expect(request).not.toHaveBeenCalled()
})
