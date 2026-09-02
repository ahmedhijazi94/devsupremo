import { describe, expect, it } from 'vitest'
import {
  evaluateMergeEligibility,
  SECURITY_GATES,
  type CheckRun,
} from './merge-policy'

const REQUIRED = ['Tipos, lint e auditoria', 'Testes e cobertura', 'Build de produção']
const SHA = 'a'.repeat(40)

function ok(name: string): CheckRun {
  return { name, status: 'completed', conclusion: 'success' }
}

describe('evaluateMergeEligibility — código não validado nunca entra na main', () => {
  it('libera merge quando TODOS os required checks do HEAD atual passam', () => {
    const r = evaluateMergeEligibility({
      requiredChecks: REQUIRED,
      checkRuns: REQUIRED.map(ok),
      prHeadSha: SHA,
      validatedSha: SHA,
    })
    expect(r.decision).toBe('merge')
    expect(r.state).toBe('validated')
  })

  it('SHA verde antigo NUNCA libera SHA novo (anti-TOCTOU)', () => {
    const r = evaluateMergeEligibility({
      requiredChecks: REQUIRED,
      checkRuns: REQUIRED.map(ok), // todos verdes...
      prHeadSha: 'b'.repeat(40), // ...mas para OUTRO HEAD
      validatedSha: SHA,
    })
    expect(r.decision).not.toBe('merge')
    expect(r.decision).toBe('wait')
    expect(r.reasons.join(' ')).toMatch(/HEAD mudou/i)
  })

  it('check obrigatório AUSENTE bloqueia o merge (ausência ≠ sucesso)', () => {
    const r = evaluateMergeEligibility({
      requiredChecks: REQUIRED,
      checkRuns: [ok(REQUIRED[0]!), ok(REQUIRED[1]!)], // falta o Build
      prHeadSha: SHA,
      validatedSha: SHA,
    })
    expect(r.decision).toBe('wait')
    expect(r.missing).toContain('Build de produção')
  })

  it('check obrigatório FAILED bloqueia o merge', () => {
    const r = evaluateMergeEligibility({
      requiredChecks: REQUIRED,
      checkRuns: [
        ok(REQUIRED[0]!),
        ok(REQUIRED[1]!),
        { name: 'Build de produção', status: 'completed', conclusion: 'failure' },
      ],
      prHeadSha: SHA,
      validatedSha: SHA,
    })
    expect(r.decision).toBe('blocked')
    expect(r.failing).toContain('Build de produção')
  })

  it('check obrigatório CANCELLED/TIMED_OUT/SKIPPED não libera merge', () => {
    for (const conclusion of ['cancelled', 'timed_out', 'skipped', 'action_required', 'neutral']) {
      const r = evaluateMergeEligibility({
        requiredChecks: REQUIRED,
        checkRuns: [
          ok(REQUIRED[0]!),
          ok(REQUIRED[1]!),
          { name: 'Build de produção', status: 'completed', conclusion },
        ],
        prHeadSha: SHA,
        validatedSha: SHA,
      })
      expect(r.decision, `conclusion=${conclusion}`).toBe('blocked')
      expect(r.failing).toContain('Build de produção')
    }
  })

  it('check obrigatório ainda RODANDO → wait (não bloqueia o agente)', () => {
    const r = evaluateMergeEligibility({
      requiredChecks: REQUIRED,
      checkRuns: [
        ok(REQUIRED[0]!),
        ok(REQUIRED[1]!),
        { name: 'Build de produção', status: 'in_progress', conclusion: null },
      ],
      prHeadSha: SHA,
      validatedSha: SHA,
    })
    expect(r.decision).toBe('wait')
    expect(r.state).toBe('ci_running')
    expect(r.pending).toContain('Build de produção')
  })

  it('falha em gate de SEGURANÇA marca security_blocked', () => {
    const securityGate = SECURITY_GATES[0]!
    const r = evaluateMergeEligibility({
      requiredChecks: [...REQUIRED, securityGate],
      checkRuns: [
        ...REQUIRED.map(ok),
        { name: securityGate, status: 'completed', conclusion: 'failure' },
      ],
      prHeadSha: SHA,
      validatedSha: SHA,
    })
    expect(r.decision).toBe('blocked')
    expect(r.state).toBe('security_blocked')
    expect(r.reasons.join(' ')).toMatch(/CRÍTICA de segurança/i)
  })

  it('sem required checks definidos → fail-closed (não libera)', () => {
    const r = evaluateMergeEligibility({
      requiredChecks: [],
      checkRuns: [],
      prHeadSha: SHA,
      validatedSha: SHA,
    })
    expect(r.decision).toBe('blocked')
    expect(r.reasons.join(' ')).toMatch(/fail-closed/i)
  })

  it('checks extras que passam não afetam — só os required importam', () => {
    const r = evaluateMergeEligibility({
      requiredChecks: REQUIRED,
      checkRuns: [...REQUIRED.map(ok), ok('Um check opcional qualquer')],
      prHeadSha: SHA,
      validatedSha: SHA,
    })
    expect(r.decision).toBe('merge')
  })
})
