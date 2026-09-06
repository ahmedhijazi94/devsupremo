import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { readCheckpointFeedback, readFeedbackEnvelope, saveCheckpointFeedback } from './feedback-store'
import { buildValidationFeedback } from './feedback'
const projectId = '11111111-1111-4111-8111-111111111111'
const checkpointId = '22222222-2222-4222-8222-222222222222'
const failure = buildValidationFeedback({ projectId, checkpointId, commitSha: 'a'.repeat(40), publishedSha: 'b'.repeat(40), checksSha: 'b'.repeat(40),
  observedAt: '2026-09-06T01:00:00.000Z', required: ['coverage'], integrated: false,
  checks: [{ name: 'coverage', status: 'completed', conclusion: 'failure' }], evidence: '70% < 80%' })
const identity = { id: checkpointId, commit_sha: failure.commitSha, published_sha: failure.publishedSha }
function db(rows: unknown[]) {
  const query = { select: vi.fn(), eq: vi.fn(), not: vi.fn(), order: vi.fn(), limit: vi.fn(), update: vi.fn(), or: vi.fn(), maybeSingle: vi.fn() }
  for (const method of ['select', 'eq', 'not', 'order', 'limit', 'update'] as const) query[method].mockReturnValue(query)
  query.maybeSingle.mockImplementation(async () => ({ data: rows.shift(), error: null }))
  query.or.mockResolvedValue({ error: null })
  return { client: { from: () => query } as unknown as SupabaseClient, query }
}
describe('persisted recovery memory', () => {
  it('does not resurrect a failure after a validated successor when another checkpoint starts', async () => {
    const store = db([null, { ...identity, created_at: '2026-09-06T02:00:00Z', validation_success: { ...failure, state: 'passed', failures: [], checks: [{ name: 'coverage', status: 'passed' }], observedAt: '2026-09-06T02:10:00.000Z' } },
      { ...identity, created_at: '2026-09-06T01:00:00Z', validation_failure: failure }])
    expect(await readFeedbackEnvelope(store.client, projectId, checkpointId)).toEqual({ current: null, previousFailure: null })
  })
  it('retains a failure observed after a successful attempt on the same checkpoint', async () => {
    const store = db([{ ...identity, validation_feedback: { ...failure, state: 'pending' } },
      { ...identity, created_at: '2026-09-06T00:00:00Z', validation_success: { ...failure, state: 'passed', failures: [], checks: [{ name: 'coverage', status: 'passed' }], observedAt: '2026-09-06T00:10:00.000Z' } },
      { ...identity, created_at: '2026-09-06T00:00:00Z', validation_failure: failure }])
    expect((await readFeedbackEnvelope(store.client, projectId, checkpointId)).previousFailure).toEqual(failure)
  })
  it('pins every write to project + checkpoint + SHA and rejects an older observation atomically', async () => {
    const store = db([])
    await saveCheckpointFeedback(store.client, failure)
    expect(store.query.eq.mock.calls).toEqual([['project_id', projectId], ['id', checkpointId], ['commit_sha', failure.commitSha], ['published_sha', failure.publishedSha]])
    expect(store.query.or).toHaveBeenCalledWith(`validation_feedback.is.null,validation_feedback->>observedAt.lt.${failure.observedAt}`)
    expect(store.query.update).toHaveBeenCalledWith({ validation_feedback: failure, validation_failure: failure })
  })
  it.each([
    { projectId: '33333333-3333-4333-8333-333333333333' },
    { checkpointId: '33333333-3333-4333-8333-333333333333' },
    { commitSha: 'c'.repeat(40) },
    { publishedSha: 'c'.repeat(40) },
  ])('refuses corrupt or stale stored identity instead of treating it as a clean state: %j', async (patch) => {
    const store = db([{ ...identity, validation_feedback: { ...failure, ...patch } }])
    await expect(readCheckpointFeedback(store.client, projectId, checkpointId)).rejects.toThrow(/SHA/)
  })
  it('sanitizes evidence again at the persistence boundary and on legacy reads', async () => {
    const unsafe = { ...failure, evidence: 'authorization=Bearer private\ncookie=session_private', summary: 'token=private',
      checks: [{ name: 'unit token=private-check-token', status: 'failed' as const }] }
    const store = db([{ ...identity, validation_feedback: unsafe }])
    await saveCheckpointFeedback(store.client, unsafe)
    expect(JSON.stringify(store.query.update.mock.calls)).not.toContain('Bearer private')
    expect(JSON.stringify(store.query.update.mock.calls)).not.toContain('private-check-token')
    const result = await readCheckpointFeedback(store.client, projectId, checkpointId)
    expect(result?.summary).toBe('token=[REDACTED]')
    expect(result?.evidence).not.toContain('Bearer private')
    expect(result?.evidence).not.toContain('session_private')
    expect(result?.checks?.[0]?.name).toBe('unit token=[REDACTED]')
  })
  it('rejects a pending observation stored as proof that recovery succeeded', async () => {
    const store = db([null, { ...identity, created_at: '2026-09-06T02:00:00Z', validation_success: { ...failure, state: 'pending' } },
      { ...identity, created_at: '2026-09-06T01:00:00Z', validation_failure: failure }])
    await expect(readFeedbackEnvelope(store.client, projectId, checkpointId)).rejects.toThrow(/histórico/)
  })
})
