import { expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { readEnvironment, registerDevelopment } from './store'
it('registro usa insert imutável; falhas nunca geram development implícito', async () => {
  const insert = vi.fn(async () => ({ error: null as unknown }))
  const maybeSingle = vi.fn(async (): Promise<{ data: unknown; error: unknown }> => ({ data: null, error: null }))
  const chain = { select: vi.fn(), eq: vi.fn(), maybeSingle, insert }
  chain.select.mockReturnValue(chain); chain.eq.mockReturnValue(chain)
  const client = { from: vi.fn(() => chain) } as unknown as SupabaseClient
  await registerDevelopment(client, 'project', 'dev-ref')
  expect(insert).toHaveBeenCalledWith({ project_id: 'project', project_ref: 'dev-ref', environment: 'development', source: 'supremo_provisioned' })
  expect(await readEnvironment(client, 'project')).toBeNull()
  maybeSingle.mockResolvedValue({ data: { project_ref: 'dev-ref', environment: 'development', source: 'supremo_provisioned' }, error: null })
  expect(await readEnvironment(client, 'project')).toMatchObject({ environment: 'development' })
  maybeSingle.mockResolvedValue({ data: null, error: 'unavailable' })
  await expect(readEnvironment(client, 'project')).rejects.toThrow(/verificar/)
  insert.mockResolvedValueOnce({ error: 'denied' })
  await expect(registerDevelopment(client, 'project', 'ref')).rejects.toThrow()
})
