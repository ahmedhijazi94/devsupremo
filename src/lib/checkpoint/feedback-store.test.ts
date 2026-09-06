import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { readFeedbackEnvelope, saveCheckpointFeedback } from './feedback-store'
import { buildValidationFeedback } from './feedback'
const projectId = '11111111-1111-4111-8111-111111111111'
const checkpointId = '22222222-2222-4222-8222-222222222222'
const failure = buildValidationFeedback({ projectId, checkpointId, commitSha: 'a'.repeat(40), publishedSha: 'b'.repeat(40), checksSha: 'b'.repeat(40),
  observedAt: '2026-09-06T01:00:00.000Z', required: ['coverage'], integrated: false,
  checks: [{ name: 'coverage', status: 'completed', conclusion: 'failure' }], evidence: '70% < 80%' })
function db(rows: unknown[]) {
  const query = { select: vi.fn(), eq: vi.fn(), not: vi.fn(), order: vi.fn(), limit: vi.fn(), update: vi.fn(), or: vi.fn(), maybeSingle: vi.fn() }
  for (const method of ['select', 'eq', 'not', 'order', 'limit', 'update'] as const) query[method].mockReturnValue(query)
  query.maybeSingle.mockImplementation(async () => ({ data: rows.shift(), error: null }))
  query.or.mockResolvedValue({ error: null })
  return { client: { from: () => query } as unknown as SupabaseClient, query }
}
describe('persisted recovery memory', () => {
  it('does not resurrect a failure after a validated successor when another checkpoint starts', async () => {
    const store = db([null, { created_at: '2026-09-06T02:00:00Z', validation_success: { ...failure, state: 'passed', observedAt: '2026-09-06T02:10:00.000Z' } },
      { created_at: '2026-09-06T01:00:00Z', validation_failure: failure }])
    expect(await readFeedbackEnvelope(store.client, projectId, checkpointId)).toEqual({ current: null, previousFailure: null })
  })
  it('retains a failure observed after a successful attempt on the same checkpoint', async () => {
    const store = db([{ validation_feedback: { ...failure, state: 'pending' } },
      { created_at: '2026-09-06T00:00:00Z', validation_success: { ...failure, state: 'passed', observedAt: '2026-09-06T00:10:00.000Z' } },
      { created_at: '2026-09-06T00:00:00Z', validation_failure: failure }])
    expect((await readFeedbackEnvelope(store.client, projectId, checkpointId)).previousFailure).toEqual(failure)
  })
  it('pins every write to project + checkpoint + SHA and rejects an older observation atomically', async () => {
    const store = db([])
    await saveCheckpointFeedback(store.client, failure)
    expect(store.query.eq.mock.calls).toEqual([['project_id', projectId], ['id', checkpointId], ['published_sha', failure.publishedSha]])
    expect(store.query.or).toHaveBeenCalledWith(`validation_feedback.is.null,validation_feedback->>observedAt.lt.${failure.observedAt}`)
    expect(store.query.update).toHaveBeenCalledWith({ validation_feedback: failure, validation_failure: failure })
  })
})
