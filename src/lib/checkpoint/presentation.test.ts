import { expect, it } from 'vitest'
import { checkpointTitle, checkpointValidationSummary, postMergeBadge } from './presentation'
import { buildValidationFeedback } from './feedback'

it('uses descriptive titles and identifies changed files when hosts supplied no description', () => {
  expect(checkpointTitle(' Botões\nprincipais em azul ')).toBe('Botões principais em azul')
  expect(checkpointTitle('Unidade de trabalho', ['.supremo/runtime.json', 'app/globals.css'])).toBe('Alterações em app/globals.css')
  expect(checkpointTitle(undefined, ['a', 'a', 'b', 'c'])).toBe('Alterações em a, b e mais 1 arquivos')
  expect(checkpointTitle('')).toBe('Alteração sem descrição')
  expect(checkpointTitle('Token=secret')).not.toContain('secret')
  expect(checkpointTitle('a'.repeat(1000)).length).toBe(180)
})
it('distinguishes old snapshot diagnostics from final integrated proof', () => {
  const failed = buildValidationFeedback({ projectId: '11111111-1111-4111-8111-111111111111', checkpointId: '22222222-2222-4222-8222-222222222222',
    commitSha: 'a'.repeat(40), publishedSha: 'b'.repeat(40), checksSha: 'b'.repeat(40), observedAt: '2026-09-13T10:00:00.000Z', required: ['E2E'], integrated: false,
    checks: [{ name: 'E2E', status: 'completed', conclusion: 'failure' }], evidence: 'Old failure' })
  expect(checkpointValidationSummary(false, failed)).toBe(failed.summary)
  expect(checkpointValidationSummary(true, failed)).toContain('versão final')
  expect(checkpointValidationSummary(true, { ...failed, state: 'integrated' })).toBe('Versão validada e integrada.')
  expect(checkpointValidationSummary(false, null)).toBe('')
  expect(postMergeBadge(false, 'pending')).toBeUndefined()
  expect(postMergeBadge(true, 'pending')).toBe('Integrado — verificações finais em andamento')
  expect(postMergeBadge(true, 'failed')).toContain('falha')
  expect(postMergeBadge(true, 'passed')).toContain('aprovados')
})
