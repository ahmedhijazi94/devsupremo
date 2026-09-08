import { describe, expect, it } from 'vitest'
import { inferLocalDiagnostic, localDiagnosticCodeSchema, presentLocalDiagnostic, readLocalDiagnostic } from './local-diagnostic'
import { validationFeedbackSchema } from './feedback'

const stored = { source: 'local', version: 1, projectId: '11111111-1111-4111-8111-111111111111',
  checkpointId: '22222222-2222-4222-8222-222222222222', commitSha: 'a'.repeat(40), revision: 4, code: 'acceptance_test_path' }
const current = { ...stored, validationStatus: 'failed' }

describe('safe local checkpoint diagnostics', () => {
  it('explains the E2E contract failure without copying private paths, logs or credentials', () => {
    const logs = 'secret=private\nchecks[0].files[0] private-project/app/actions.test.ts\nTest path must name a project test'
    const code = inferLocalDiagnostic({ logs, checks: [{ name: 'validation infrastructure', type: 'external_dependency', status: 'failed' }] })
    expect(code).toBe('acceptance_test_path')
    const view = presentLocalDiagnostic(code)
    expect(view.stage).toBe('Contrato de testes')
    expect(view.cause).toContain('antes de executar')
    expect(view.nextStep).toContain('correção e nova validação')
    expect(JSON.stringify(view)).not.toMatch(/private|secret|actions\.test/)
  })
  it('recognizes separate contract and integrity failures', () => {
    expect(inferLocalDiagnostic({ logs: '', checks: [{ name: 'acceptance contract', type: 'code', status: 'failed' }] })).toBe('acceptance_contract')
    expect(inferLocalDiagnostic({ logs: '', checks: [{ name: 'validation integrity', type: 'security', status: 'failed' }] })).toBe('validation_integrity')
  })
  it.each([
    ['typecheck', 'typecheck'], ['lint', 'lint'], ['build', 'build'], ['security', 'security'],
    ['rls', 'rls'], ['migration', 'migration'], ['environment', 'environment'],
    ['unit', 'tests'], ['integration', 'tests'], ['e2e', 'tests'], ['external_dependency', 'infrastructure'], ['unknown', 'validation'],
  ])('maps %s failures to a fixed %s diagnostic', (type, code) => {
    expect(inferLocalDiagnostic({ logs: 'private', checks: [{ name: 'private', type, status: 'failed' }] })).toBe(code)
  })
  it('does not derive a failure from a passing check and only accepts an explicit code', () => {
    expect(inferLocalDiagnostic({ logs: '', checks: [{ name: 'acceptance contract', status: 'passed' }] })).toBe('validation')
    expect(localDiagnosticCodeSchema.safeParse('password=private').success).toBe(false)
  })
  it('only displays the current checkpoint revision, never a success or CI approval', () => {
    expect(readLocalDiagnostic(stored, current)?.stage).toBe('Contrato de testes')
    for (const patch of [{ revision: 5 }, { commitSha: 'b'.repeat(40) }, { validationStatus: 'passed' },
      { projectId: '33333333-3333-4333-8333-333333333333' }, { checkpointId: '33333333-3333-4333-8333-333333333333' }]) {
      expect(readLocalDiagnostic(stored, { ...current, ...patch })).toBeUndefined()
    }
    expect(readLocalDiagnostic({ ...stored, logs: 'private' }, current)).toBeUndefined()
    expect(validationFeedbackSchema.safeParse(stored).success).toBe(false)
  })
})
