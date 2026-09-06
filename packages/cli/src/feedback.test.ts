import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { refreshLocalFeedback, FEEDBACK_FILE } from './feedback'

const dirs: string[] = []
afterEach(() => { vi.unstubAllGlobals(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })
const projectId = '11111111-1111-4111-8111-111111111111'
const snapshot = {
  projectId, checkpointId: '22222222-2222-4222-8222-222222222222', commitSha: 'a'.repeat(40), publishedSha: 'b'.repeat(40),
  observedAt: '2026-09-06T01:00:00.000Z', state: 'failed', failures: [{ name: 'coverage', category: 'code' }], summary: 'Coverage below threshold', evidence: '70% < 80%',
}
function setup() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-test-')); dirs.push(cwd)
  return { cwd, projectId, apiBaseUrl: 'https://supremo.test', getSecret: () => 'test-device-secret' }
}
function respond(current: unknown, previousFailure: unknown = null) {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ current, previousFailure })))
}
describe('daemon feedback cache', () => {
  it('persists failure → pending correction → confirmed green, across worker restarts', async () => {
    const config = setup(); const file = path.join(config.cwd, FEEDBACK_FILE)
    respond(snapshot)
    expect(await refreshLocalFeedback(config)).toBe(true)
    expect(fs.readFileSync(file, 'utf8')).not.toContain('test-device-secret')
    respond({ ...snapshot, observedAt: '2026-09-06T01:01:00.000Z', state: 'pending', failures: [], evidence: '' }, snapshot)
    await refreshLocalFeedback(config)
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).previousFailure.evidence).toBe('70% < 80%')
    respond({ ...snapshot, observedAt: '2026-09-06T01:02:00.000Z', state: 'passed', failures: [], evidence: '' })
    await refreshLocalFeedback(config)
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ current: { state: 'passed' }, previousFailure: null })
  })
  it('does not resurrect a failure resolved on the server while the daemon was offline', async () => {
    const config = setup(); const file = path.join(config.cwd, FEEDBACK_FILE)
    respond(snapshot); await refreshLocalFeedback(config)
    respond({ ...snapshot, observedAt: '2026-09-06T01:03:00.000Z', state: 'pending', failures: [], evidence: '' })
    expect(await refreshLocalFeedback(config)).toBe(true)
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).previousFailure).toBeNull()
  })
  it('preserves evidence on offline, invalid data, foreign project and out-of-order delivery', async () => {
    const config = setup(); const file = path.join(config.cwd, FEEDBACK_FILE)
    respond(snapshot); await refreshLocalFeedback(config)
    const original = fs.readFileSync(file, 'utf8')
    for (const bad of [{ ...snapshot, projectId: '33333333-3333-4333-8333-333333333333' }, {}, { ...snapshot, observedAt: '2026-09-05T01:00:00.000Z' }]) {
      respond(bad); expect(await refreshLocalFeedback(config)).toBe(false)
      expect(fs.readFileSync(file, 'utf8')).toBe(original)
    }
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    expect(await refreshLocalFeedback(config)).toBe(false)
    expect(fs.readFileSync(file, 'utf8')).toBe(original)
  })
  it('does not fetch without device credentials', async () => {
    respond(snapshot)
    expect(await refreshLocalFeedback({ ...setup(), getSecret: () => null })).toBe(false)
    expect(fetch).not.toHaveBeenCalled()
  })
})
