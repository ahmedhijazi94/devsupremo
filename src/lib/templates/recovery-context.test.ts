import { describe, it, expect } from 'vitest'
import { recoveryContextScript } from './recovery-context'
import { buildValidationFeedback } from '../checkpoint/feedback'

const projectId = '11111111-1111-4111-8111-111111111111'
const checkpointId = '22222222-2222-4222-8222-222222222222'
function read(cache: unknown, queue = [{ projectId, checkpointId }]) {
  const script = recoveryContextScript().replace("import fs from 'node:fs'", '').replace('export function', 'function')
  return new Function('fs', `${script}; return readRecoveryContext()` )({ readFileSync: (file: string) => {
    if (file.endsWith('project.json')) return JSON.stringify({ projectId })
    if (file.endsWith('queue.jsonl')) return queue.map((row) => JSON.stringify(row)).join('\n')
    if (!cache) throw new Error('missing')
    return JSON.stringify(cache)
  } }) as { action: string; stale: boolean; matchesLocal?: boolean; failure?: { evidence: string } }
}
const failed = () => buildValidationFeedback({ projectId, checkpointId, commitSha: 'a'.repeat(40), publishedSha: 'b'.repeat(40), checksSha: 'b'.repeat(40),
  observedAt: new Date().toISOString(), integrated: false, required: ['coverage'], checks: [{ name: 'coverage', status: 'completed', conclusion: 'failure' }], evidence: '70% < 80%' })
describe('generated preflight recovery', () => {
  it('gives the next prompt the failure and keeps old/outdated evidence distinct', () => {
    expect(read({ current: failed(), previousFailure: null })).toMatchObject({ action: 'repair', stale: false, failure: { evidence: '70% < 80%' } })
    expect(read({ current: { ...failed(), observedAt: '2020-01-01T00:00:00.000Z' } })).toMatchObject({ action: 'verify_previous_failure', stale: true })
    expect(read({ current: failed() }, [{ projectId, checkpointId: 'new-local' }]).action).toBe('verify_previous_failure')
  })
  it('does not confuse appended upload updates with the latest local checkpoint', () => {
    expect(read({ current: failed() }, [{ projectId, checkpointId }, { projectId, checkpointId: 'new-local' }, { projectId, checkpointId }]).matchesLocal).toBe(false)
  })
  it('continues on current green and treats missing, invalid or foreign snapshots as unknown', () => {
    expect(read({ current: { ...failed(), state: 'passed', failures: [], evidence: '' } }).action).toBe('continue')
    expect(read(null).action).toBe('unknown')
    expect(read({ current: {} }).action).toBe('unknown')
    expect(read({ current: { ...failed(), projectId: 'foreign' } }).action).toBe('unknown')
    expect(read({ current: null, previousFailure: failed() }).action).toBe('verify_previous_failure')
  })
})
