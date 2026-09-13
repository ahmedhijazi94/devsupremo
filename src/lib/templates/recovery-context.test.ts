import { describe, it, expect } from 'vitest'
import { recoveryContextScript } from './recovery-context'
import { buildValidationFeedback } from '../checkpoint/feedback'

const projectId = '11111111-1111-4111-8111-111111111111'
const checkpointId = '22222222-2222-4222-8222-222222222222'
function read(cache: unknown, queue: { projectId: string; checkpointId: string; commitSha?: string }[] = [{ projectId, checkpointId, commitSha: 'a'.repeat(40) }], lifecycle: unknown = {}) {
  const script = recoveryContextScript().replace("import fs from 'node:fs'", '').replace('export function', 'function')
  return new Function('fs', `${script}; return readRecoveryContext()` )({ readFileSync: (file: string) => {
    if (file.endsWith('lifecycle.json')) return JSON.stringify(lifecycle)
    if (file.endsWith('project.json')) return JSON.stringify({ projectId })
    if (file.endsWith('queue.jsonl')) return queue.map((row) => JSON.stringify(row)).join('\n')
    if (!cache) throw new Error('missing')
    return JSON.stringify(cache)
  } }) as { action: string; stale: boolean; matchesLocal?: boolean; developmentPolicy?: { validation: string; previousFailures: string }; instruction?: string; failure?: { checkpointId: string; evidence: string } | null }
}
const failed = () => buildValidationFeedback({ projectId, checkpointId, commitSha: 'a'.repeat(40), publishedSha: 'b'.repeat(40), checksSha: 'b'.repeat(40),
  observedAt: new Date().toISOString(), integrated: false, required: ['coverage'], checks: [{ name: 'coverage', status: 'completed', conclusion: 'failure' }], evidence: '70% < 80%' })
describe('generated preflight recovery', () => {
  it('gives the next prompt the failure and keeps old/outdated evidence distinct', () => {
    expect(read({ current: failed(), previousFailure: null })).toMatchObject({ action: 'repair_before_request', stale: false, failure: { evidence: '70% < 80%' } })
    expect(read({ current: { ...failed(), observedAt: '2020-01-01T00:00:00.000Z' } })).toMatchObject({ action: 'repair_before_request', stale: true })
    expect(read({ current: failed() }, [{ projectId, checkpointId: 'new-local' }]).action).toBe('repair_before_request')
  })
  it('instructs the current agent to repair confirmed failures and verify them without reducing gates', () => {
    const result = read({ current: failed() })
    expect(result).toMatchObject({ developmentPolicy: { validation: 'background_adaptive', previousFailures: 'repair_before_request' } })
    expect(result.instruction).toContain('confira se a falha ainda existe no código atual')
    expect(result.instruction).toContain('antes do pedido novo, sem esperar o usuário avisar')
    expect(result.instruction).toContain('preservando assertions, comportamento e requisitos')
    expect(result.instruction).toContain('turn recovery-check em snapshot isolado')
    expect(result.instruction).toContain('Não reduza cobertura, remova provas ou enfraqueça gates')
    expect(result.instruction).toContain('Pedidos explicitamente só de leitura ou para não alterar o app não iniciam correções')
    expect(result.instruction).toContain('Só declare resolução com prova atual')
  })
  it('respects an explicit on-request validation override without hiding previous diagnostics', () => {
    expect(read({ current: failed() }, undefined, { validation_mode: 'on_request' })).toMatchObject({
      developmentPolicy: { validation: 'on_request', previousFailures: 'repair_before_request' },
      action: 'repair_before_request',
    })
  })
  it('permits development fixes for security/infrastructure while preserving execution and integration authority', () => {
    for (const category of ['security', 'infrastructure']) {
      const result = read({ current: { ...failed(), observedAt: '2020-01-01T00:00:00.000Z', failures: [{ name: 'Required gate', category }] } })
      expect(result).toMatchObject({ action: 'repair_before_request', stale: true, developmentPolicy: { previousFailures: 'repair_before_request' } })
      expect(result.instruction).toContain('Evidência antiga não prova falha atual')
      expect(result.instruction).toContain('Aplicar SQL, publicar e integrar continuam sujeitos à autoridade')
      expect(result.instruction).toContain('Não inicie repair-start por rotina')
      expect(result.instruction).toContain('explique a causa concreta e a ação necessária')
    }
  })
  it('preserves actionable error excerpts near the end of the bounded diagnostic', () => {
    const evidence = 'x'.repeat(7062) + 'app/login/login-form.test.tsx:98:43\ncomplete called before the mock started'
    expect(read({ current: { ...failed(), evidence } }).failure?.evidence).toBe(evidence)
    expect(read({ current: { ...failed(), evidence: 'x'.repeat(9000) } }).failure?.evidence).toHaveLength(8000)
  })
  it('does not confuse appended upload updates with the latest local checkpoint', () => {
    expect(read({ current: failed() }, [{ projectId, checkpointId }, { projectId, checkpointId: 'new-local' }, { projectId, checkpointId }]).matchesLocal).toBe(false)
  })
  it('continues on current green and treats missing, invalid or foreign snapshots as unknown', () => {
    expect(read({ current: { ...failed(), state: 'passed', failures: [], evidence: '' } }).action).toBe('continue')
    expect(read(null).action).toBe('unknown')
    expect(read({ current: {} }).action).toBe('unknown')
    expect(read({ current: { ...failed(), projectId: 'foreign' } }).action).toBe('unknown')
    expect(read({ current: null, previousFailure: failed() }).action).toBe('repair_before_request')
  })

  it.each(['passed', 'integrated'] as const)('does not revive a failure after a newer %s result for the same checkpoint', (state) => {
    const previousFailure = { ...failed(), observedAt: new Date(Date.now() - 30_000).toISOString() }
    const current = { ...previousFailure, observedAt: new Date().toISOString(), state, failures: [], evidence: '',
      checks: [{ name: 'coverage', status: 'passed' }] }
    expect(read({ current, previousFailure })).toMatchObject({ action: 'continue', failure: null,
      developmentPolicy: { previousFailures: 'none' } })
  })

  it('retires the old diagnostic only for a newer green checkpoint linked to the latest local snapshot', () => {
    const previousFailure = { ...failed(), observedAt: new Date(Date.now() - 30_000).toISOString() }
    const current = { ...previousFailure, checkpointId: '33333333-3333-4333-8333-333333333333', commitSha: 'c'.repeat(40),
      publishedSha: 'd'.repeat(40), observedAt: new Date().toISOString(), state: 'passed', failures: [], evidence: '',
      checks: [{ name: 'coverage', status: 'passed' }] }
    const original = { projectId, checkpointId, commitSha: previousFailure.commitSha }
    const successor = { projectId, checkpointId: current.checkpointId, commitSha: current.commitSha }
    expect(read({ current, previousFailure }, [original, successor, original])).toMatchObject({ action: 'continue', failure: null })
    const unrelatedQueues = [
      [successor, original],
      [original],
      [successor],
      [original, { ...successor, projectId: 'foreign' }],
      [original, { ...successor, commitSha: 'e'.repeat(40) }],
      [original, successor, { projectId, checkpointId: 'newer-local', commitSha: 'e'.repeat(40) }],
    ]
    for (const queue of unrelatedQueues) {
      expect(read({ current, previousFailure }, queue)).toMatchObject({ action: 'repair_before_request', failure: { checkpointId } })
    }
  })

  it.each(['older-result', 'future-result', 'different-sha', 'failed-check', 'failed-gate'] as const)('does not let %s hide an unresolved diagnostic', (scenario) => {
    const previousFailure = failed()
    const current = { ...previousFailure, state: 'passed', failures: scenario === 'failed-gate' ? previousFailure.failures : [],
      checks: [{ name: 'coverage', status: scenario === 'failed-check' ? 'pending' : 'passed' }],
      observedAt: new Date(Date.now() + (scenario === 'older-result' ? -30_000 : scenario === 'future-result' ? 120_000 : 1000)).toISOString(),
      commitSha: scenario === 'different-sha' ? 'c'.repeat(40) : previousFailure.commitSha }
    expect(read({ current, previousFailure })).toMatchObject({ action: 'repair_before_request', failure: { checkpointId } })
  })

  it('delivers the newest failed observation instead of an older current entry', () => {
    const current = { ...failed(), observedAt: new Date(Date.now() - 30_000).toISOString() }
    const previousFailure = { ...failed(), evidence: 'New failing assertion' }
    expect(read({ current, previousFailure }).failure?.evidence).toBe('New failing assertion')
  })
})
