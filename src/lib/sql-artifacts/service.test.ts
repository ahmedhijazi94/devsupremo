import { expect, it, vi } from 'vitest'
import { advanceSqlArtifact, artifactDigest, assertMaterialization, type SqlArtifactPort } from './service'
import type { SqlArtifact } from './contract'

function fixture(state: SqlArtifact['state']) {
  let artifact: SqlArtifact = { id: '11111111-1111-4111-8111-111111111111', projectId: '22222222-2222-4222-8222-222222222222', projectRef: 'example', environment: 'development',
    path: 'supabase/migrations/20261005123456_11111111111141118111111111111111.sql', content: 'create index example on public.notes(id);', digest: artifactDigest('create index example on public.notes(id);'),
    state, claimToken: '33333333-3333-4333-8333-333333333333', message: '', types: null, updatedAt: new Date().toISOString() }
  const port: SqlArtifactPort = { authorize: vi.fn(async () => {}), execute: vi.fn(async () => 'succeeded' as const), history: vi.fn(async () => 'matching' as const), types: vi.fn(async () => 'export type Database = {}'),
    save: vi.fn(async (next, message, types) => { artifact = { ...artifact, state: next, message, ...(types ? { types } : {}) }; return artifact }) }
  return { artifact, port }
}
it('never dispatches SQL until a matching file was acknowledged', async () => {
  const { artifact, port } = fixture('materializing')
  await expect(advanceSqlArtifact(artifact, port)).rejects.toThrow('Arquivo ainda não confirmado')
  expect(port.execute).not.toHaveBeenCalled()
  expect(() => assertMaterialization(artifact, 'a'.repeat(64))).toThrow('diverge')
})
it('records dispatch before the effect and generates types only after exact history confirmation', async () => {
  const { artifact, port } = fixture('materialized')
  const result = await advanceSqlArtifact(artifact, port)
  expect(result).toMatchObject({ state: 'applied', types: { path: 'supabase/types/20261005123456_11111111111141118111111111111111.types.ts' } })
  expect(vi.mocked(port.save).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(port.execute).mock.invocationCallOrder[0]!)
  expect(vi.mocked(port.history).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(port.types).mock.invocationCallOrder[0]!)
})
it.each(['applying', 'uncertain'] as const)('reconciles %s read-only without a second external dispatch', async state => {
  const { artifact, port } = fixture(state)
  expect((await advanceSqlArtifact(artifact, port)).state).toBe('applied')
  expect(port.execute).not.toHaveBeenCalled()
})
it('preserves uncertainty when no history can prove the outcome and does not generate types', async () => {
  const { artifact, port } = fixture('uncertain'); port.history = vi.fn(async () => 'absent' as const)
  expect((await advanceSqlArtifact(artifact, port)).state).toBe('uncertain')
  expect(port.execute).not.toHaveBeenCalled(); expect(port.types).not.toHaveBeenCalled()
})
it('refuses a divergent history and revalidates revocation before any effect', async () => {
  const { artifact, port } = fixture('applying'); port.history = vi.fn(async () => 'conflict' as const)
  expect((await advanceSqlArtifact(artifact, port)).state).toBe('conflict')
  port.authorize = async () => { throw new Error('revoked') }
  await expect(advanceSqlArtifact(artifact, port)).rejects.toThrow('revoked')
  expect(port.execute).not.toHaveBeenCalled(); expect(port.types).not.toHaveBeenCalled()
})
