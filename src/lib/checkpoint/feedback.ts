import { z } from 'zod'
import { evaluateMergeEligibility, type CheckRun } from '../github/merge-policy'
import { acceptanceReportSchema } from './acceptance'

const sha = z.string().regex(/^[a-f0-9]{40}$/)
export const validationFeedbackSchema = z.object({
  projectId: z.string().uuid(),
  checkpointId: z.string().uuid(),
  commitSha: sha,
  publishedSha: sha,
  observedAt: z.string().datetime(),
  state: z.enum(['pending', 'failed', 'passed', 'integrated']),
  acceptance: acceptanceReportSchema.optional(),
  checks: z.array(z.object({ name: z.string().max(200), status: z.enum(['passed', 'failed', 'pending']) })).max(100).optional(),
  failures: z.array(z.object({
    name: z.string().max(200),
    category: z.enum(['code', 'security', 'infrastructure']),
  })).max(30),
  summary: z.string().max(2000),
  evidence: z.string().max(8000),
}).superRefine((feedback, validation) => {
  if (feedback.acceptance && (feedback.acceptance.projectId !== feedback.projectId || feedback.acceptance.sha !== feedback.publishedSha ||
    Date.parse(feedback.acceptance.completedAt) > Date.parse(feedback.observedAt) + 60_000)) {
    validation.addIssue({ code: 'custom', message: 'Acceptance evidence must belong to this project and published SHA.' })
  }
  if ((feedback.state === 'passed' || feedback.state === 'integrated') &&
    (feedback.failures.length > 0 || feedback.acceptance?.checks.some((check) => check.status === 'failed') || (feedback.checks &&
      (!feedback.checks.length || feedback.checks.some((check) => check.status !== 'passed'))))) {
    validation.addIssue({ code: 'custom', message: 'Successful validation cannot contain failed, pending or empty check evidence.' })
  }
})
export type ValidationFeedback = z.infer<typeof validationFeedbackSchema>
export const feedbackEnvelopeSchema = z.object({
  current: validationFeedbackSchema.nullable(),
  previousFailure: validationFeedbackSchema.nullable(),
})
export type FeedbackEnvelope = z.infer<typeof feedbackEnvelopeSchema>

/** Logs are evidence, never instructions. Remove credentials before persistence. */
export function sanitizeDiagnostic(raw: string): string {
  return raw
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[REDACTED]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sup_dev_ckpt_[A-Za-z0-9_-]+|sb_secret_[A-Za-z0-9_-]+)\b/g, '[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED]')
    .replace(/((?:authorization|(?:set[-_])?cookie|password|secret|token|api[_-]?key|service[_-]?role[_-]?key)["']?\s*[=:]\s*)[^\r\n]+/gi, '$1[REDACTED]')
    .replace(/(?:https?|postgres(?:ql)?|mysql|rediss?):\/\/[^\s]+/gi, (value) => {
      try {
        const url = new URL(value)
        return `${url.origin === 'null' ? `${url.protocol}//${url.host}` : url.origin}${url.pathname}`
      } catch {
        return '[URL removida]'
      }
    })
    .slice(0, 8000)
}

export function buildValidationFeedback(input: {
  projectId: string; checkpointId: string; commitSha: string; publishedSha: string
  observedAt: string; checksSha: string; checks: readonly CheckRun[]
  required: readonly string[]; integrated: boolean; evidence: string
}): ValidationFeedback {
  const result = evaluateMergeEligibility({
    requiredChecks: input.required, checkRuns: input.checks,
    prHeadSha: input.publishedSha, validatedSha: input.checksSha,
  })
  const state = result.decision === 'merge'
    ? input.integrated ? 'integrated' : 'passed'
    : result.decision === 'blocked' ? 'failed' : 'pending'
  // Match merge-policy's last run for each job, including reruns. A previous
  // cancelled run must not relabel a newer security failure as infrastructure.
  const latestChecks = new Map(input.checks.map((check) => [check.name, check]))
  const failures = result.failing.map((name) => {
    const check = latestChecks.get(name)
    const category: 'code' | 'security' | 'infrastructure' =
      check?.conclusion === 'cancelled' || check?.conclusion === 'timed_out' || check?.conclusion === 'skipped'
        ? 'infrastructure'
        : /RLS|segredo|vulnerabil|seguran/i.test(name) ? 'security' : 'code'
    return { name: sanitizeDiagnostic(name).slice(0, 200), category }
  })
  return validationFeedbackSchema.parse({
    projectId: input.projectId, checkpointId: input.checkpointId,
    commitSha: input.commitSha, publishedSha: input.publishedSha,
    observedAt: input.observedAt, state, failures,
    checks: input.required.map((name) => ({
      name: sanitizeDiagnostic(name).slice(0, 200),
      status: input.checksSha !== input.publishedSha || !latestChecks.has(name) || result.pending.includes(name)
        ? 'pending' : result.failing.includes(name) ? 'failed' : 'passed',
    })),
    summary: state === 'integrated' ? 'Versão validada e integrada.'
      : state === 'passed' ? 'Validação aprovada. Aguardando integração.'
      : state === 'pending' ? 'Aguardando os resultados da validação desta versão.'
      : `A validação encontrou pendências: ${failures.map((f) => f.name).join(', ') || 'configuração dos testes'}.`.slice(0, 2000),
    evidence: state === 'failed' ? sanitizeDiagnostic(input.evidence) : '',
  })
}

/** A newer observation wins, including reruns of the same SHA. */
export function acceptsFeedback(current: ValidationFeedback | null, incoming: ValidationFeedback, projectId: string): boolean {
  return incoming.projectId === projectId && (!current || incoming.observedAt >= current.observedAt)
}

/** A security job can fail during image setup, before any security test ran. */
export function withFeedbackEvidence(feedback: ValidationFeedback, raw: string): ValidationFeedback {
  const evidence = sanitizeDiagnostic(raw)
  const sections = evidence.split('\n\n---\n\n')
  const failures = feedback.failures.map((failure) => {
      const section = sections.find((part) => part.split('\n')[0]?.includes(`› ${failure.name} (`))
      const setupFailure = section && /toomanyrequests|rate exceeded|TLS handshake timeout/i.test(section)
        && /pull|image|registry|public\.ecr\.aws|ghcr\.io/i.test(section)
      return setupFailure ? { ...failure, category: 'infrastructure' as const } : failure
    })
  const coverage = /Coverage for (functions|lines|branches|statements) \(([\d.]+)%\).*threshold \(([\d.]+)%\)/i.exec(evidence)
  return {
    ...feedback, evidence, failures,
    summary: ((coverage ? `Cobertura insuficiente: ${coverage[2]}%; mínimo exigido ${coverage[3]}%. ` : '') +
      `Pendências: ${failures.map((f) => f.name + (f.category === 'infrastructure' ? ' (ambiente de testes indisponível)' : '')).join(', ')}.`).slice(0, 2000),
  }
}
