import { expect, it } from 'vitest'
import { turnAgentResponse } from './turn-response'

it('preserves a refusal without inventing permission or a continuation', () => {
  expect(turnAgentResponse({ protocolVersion: 1, workerAvailable: true, allowed: false, reason: 'Outra sessão ativa.' }))
    .toMatchObject({ allowed: false, reason: 'Outra sessão ativa.' })
  expect(turnAgentResponse({ protocolVersion: 1, workerAvailable: true, allowed: false }).nextAction).toBeUndefined()
})

it('bounds and sanitizes error output without truncating the action', () => {
  const response = turnAgentResponse({ protocolVersion: 1, workerAvailable: true, allowed: false,
    reason: 'A'.repeat(2000) + ' Bearer super-secret-token ' + 'Z'.repeat(2000),
    nextAction: { kind: 'repair_previous_failure', instruction: 'Continue a correção.', command: 'turn recovery-check' } })
  expect(response.reason).not.toContain('super-secret-token')
  expect(response.reason!.length).toBeLessThan(1300)
  expect(response.reason).toContain('diagnóstico completo')
  expect(response.nextAction?.command).toBe('turn recovery-check')
})
