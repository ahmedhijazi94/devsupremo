import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { reportLocalCheckpoint } from './store'
import type { LocalCheckpointReport } from './local-report'

const report: LocalCheckpointReport = {
  deviceSecret: 'device-example', projectId: '11111111-1111-4111-8111-111111111111',
  checkpointId: '22222222-2222-4222-8222-222222222222', commitSha: 'a'.repeat(40),
  createdAt: '2026-09-08T00:00:00.000Z', revision: 2, validationStatus: 'failed',
  validatedSha: 'a'.repeat(40), uploadStatus: 'local', diagnosticCode: 'acceptance_test_path',
}

function database(outcome: string, diagnosticError: unknown = null) {
  const query = { update: vi.fn(), eq: vi.fn(), error: diagnosticError }
  query.update.mockReturnValue(query); query.eq.mockReturnValue(query)
  const client = { rpc: vi.fn(async () => ({ data: outcome, error: null })), from: vi.fn(() => query) }
  return { client: client as unknown as SupabaseClient, query, raw: client }
}

describe('local diagnostic persistence boundary', () => {
  it.each(['recorded', 'ignored'])('can fill a lost diagnostic on %s while pinning identity, revision and unpublished state', async (outcome) => {
    const db = database(outcome)
    expect(await reportLocalCheckpoint(db.client, 'device', report)).toBe(outcome)
    expect(db.query.eq.mock.calls).toEqual([
      ['id', report.checkpointId], ['project_id', report.projectId], ['device_id', 'device'],
      ['commit_sha', report.commitSha], ['push_status', 'local'], ['local_report_revision', 2], ['local_validation_status', 'failed'],
    ])
    expect(db.query.update).toHaveBeenCalledWith({ validation_feedback: {
      source: 'local', version: 1, projectId: report.projectId, checkpointId: report.checkpointId,
      commitSha: report.commitSha, revision: 2, code: 'acceptance_test_path',
    } })
    expect(JSON.stringify(db.query.update.mock.calls)).not.toContain('device-example')
  })
  it('never writes a diagnostic when device/project/checkpoint identity was refused', async () => {
    const db = database('conflict')
    expect(await reportLocalCheckpoint(db.client, 'foreign-device', report)).toBe('conflict')
    expect(db.raw.from).not.toHaveBeenCalled()
  })
  it('keeps a failed diagnostic write retryable even after its status was accepted', async () => {
    const db = database('recorded', new Error('offline'))
    await expect(reportLocalCheckpoint(db.client, 'device', report)).rejects.toThrow('diagnóstico')
  })
  it('clears an old diagnostic when a new status has no failure code', async () => {
    const db = database('recorded')
    const next = { ...report, revision: 3, validationStatus: 'pending' as const, validatedSha: null }
    delete next.diagnosticCode
    await reportLocalCheckpoint(db.client, 'device', next)
    expect(db.query.update).toHaveBeenCalledWith({ validation_feedback: null })
  })
})
