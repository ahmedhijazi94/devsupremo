import { describe, it, expect } from 'vitest'
import { acceptsFeedback, buildValidationFeedback, sanitizeDiagnostic, withFeedbackEvidence } from './feedback'

const base = {
  projectId: '11111111-1111-4111-8111-111111111111', checkpointId: '22222222-2222-4222-8222-222222222222',
  commitSha: 'a'.repeat(40), publishedSha: 'b'.repeat(40), checksSha: 'b'.repeat(40),
  observedAt: '2026-09-06T01:00:00.000Z', integrated: false,
  required: ['Testes e cobertura'], evidence: 'Coverage for functions (70%) does not meet global threshold (80%)',
}
describe('validation feedback', () => {
  it('classifies a registry outage per job without reclassifying an unrelated code failure', () => {
    const feedback = buildValidationFeedback({ ...base, required: ['Políticas RLS', 'coverage'], checks: [
      { name: 'Políticas RLS', status: 'completed', conclusion: 'failure' },
      { name: 'coverage', status: 'completed', conclusion: 'failure' },
    ] })
    const result = withFeedbackEvidence(feedback, '### CI › Políticas RLS (failure)\npull public.ecr.aws image: toomanyrequests: Rate exceeded\n\n---\n\n### CI › coverage (failure)\n70% < 80%')
    expect(result.failures.map((f) => f.category)).toEqual(['infrastructure', 'code'])
    expect(withFeedbackEvidence(feedback, 'unknown failure').failures[0]?.category).toBe('security')
  })
  it('keeps the failing gate, exact revision and actionable evidence', () => {
    const result = buildValidationFeedback({ ...base, checks: [{ name: base.required[0]!, status: 'completed', conclusion: 'failure' }] })
    expect(result).toMatchObject({ state: 'failed', publishedSha: base.publishedSha, evidence: base.evidence,
      failures: [{ name: 'Testes e cobertura', category: 'code' }] })
  })
  it('requires all checks of the matching SHA; no checks or older green never approve', () => {
    expect(buildValidationFeedback({ ...base, checks: [] }).state).toBe('pending')
    expect(buildValidationFeedback({ ...base, checksSha: 'c'.repeat(40), checks: [{ name: base.required[0]!, status: 'completed', conclusion: 'success' }] }).state).toBe('pending')
  })
  it('separates passed from integrated and erases current failure evidence only after green', () => {
    const checks = [{ name: base.required[0]!, status: 'completed' as const, conclusion: 'success' }]
    expect(buildValidationFeedback({ ...base, checks })).toMatchObject({ state: 'passed', evidence: '', failures: [] })
    expect(buildValidationFeedback({ ...base, checks, integrated: true }).state).toBe('integrated')
  })
  it('distinguishes security and interrupted infrastructure gates', () => {
    expect(buildValidationFeedback({ ...base, required: ['Políticas RLS'], checks: [{ name: 'Políticas RLS', status: 'completed', conclusion: 'failure' }] }).failures[0]?.category).toBe('security')
    for (const conclusion of ['cancelled', 'timed_out', 'skipped']) {
      expect(buildValidationFeedback({ ...base, checks: [{ name: base.required[0]!, status: 'completed', conclusion }] }).failures[0]?.category).toBe('infrastructure')
    }
  })
  it('does not let an older observation or a different project replace the current one', () => {
    const current = buildValidationFeedback({ ...base, checks: [] })
    expect(acceptsFeedback(null, current, base.projectId)).toBe(true)
    expect(acceptsFeedback(current, { ...current, observedAt: '2026-09-05T01:00:00.000Z' }, base.projectId)).toBe(false)
    expect(acceptsFeedback(current, current, 'another')).toBe(false)
    expect(acceptsFeedback(current, { ...current, observedAt: '2026-09-06T01:01:00.000Z' }, base.projectId)).toBe(true)
  })
  it('redacts credentials, private keys and URL credentials/query before clipping', () => {
    const raw = 'token=secret-value\npassword: hidden\n-----BEGIN RSA PRIVATE KEY-----\nprivate\n-----END RSA PRIVATE KEY-----\nghp_hidden sup_dev_ckpt_hidden sb_secret_hidden eyJabc.def.ghi\nhttps://user:pass@example.com/log?token=hidden\n' + 'x'.repeat(9000)
    const clean = sanitizeDiagnostic(raw)
    for (const secret of ['secret-value', 'hidden', 'private', 'user:pass', 'eyJabc']) expect(clean).not.toContain(secret)
    expect(clean).toContain('https://example.com/log')
    expect(clean.length).toBe(8000)
    expect(sanitizeDiagnostic('https://%invalid')).toBe('[URL removida]')
  })
})
