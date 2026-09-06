import { z } from 'zod'
import {
  feedbackEnvelopeSchema,
  sanitizeDiagnostic,
  type FeedbackEnvelope,
  type ValidationFeedback,
} from '../../../src/lib/checkpoint/feedback'

/** Host-independent lifecycle. The adapter supplies observations, never authority. */
export const TURN_PHASES = ['preflight', 'work', 'background_validation', 'postflight', 'recovery'] as const
export const FAILURE_TYPES = ['code', 'typecheck', 'lint', 'build', 'unit', 'integration', 'e2e', 'rls', 'security', 'migration', 'runtime', 'environment', 'external_dependency', 'unknown'] as const
export const DEFAULT_MAX_AUTO_REPAIR_ATTEMPTS = 3
export const turnEnvironmentSchema = z.enum(['development', 'production', 'unknown'])
export type TurnEnvironment = z.infer<typeof turnEnvironmentSchema>
export type IntegrationMode = 'enforced' | 'assisted' | 'unsupported'
export type FailureType = typeof FAILURE_TYPES[number]
export type TurnPhase = typeof TURN_PHASES[number]
export type ProjectHealth = 'developing' | 'validating' | 'healthy' | 'repairing' | 'blocked' | 'needs_attention'

const shaSchema = z.string().regex(/^[a-f0-9]{40}$/)
const fingerprintSchema = z.string().min(1).max(200)
export const workspaceSnapshotSchema = z.object({
  projectId: z.string().uuid(), environment: turnEnvironmentSchema,
  headSha: shaSchema, fingerprint: fingerprintSchema, dirty: z.boolean(),
})
export type WorkspaceSnapshot = z.infer<typeof workspaceSnapshotSchema>

export const checkpointLinkSchema = z.object({
  checkpointId: z.string().uuid(), projectId: z.string().uuid(),
  commitSha: shaSchema, publishedSha: shaSchema.nullable(),
  environment: turnEnvironmentSchema, createdAt: z.string().datetime(),
  fingerprint: fingerprintSchema.optional(),
})
export type CheckpointLink = z.infer<typeof checkpointLinkSchema>

export const recoveryFailureSchema = z.object({
  name: z.string().min(1).max(200), type: z.enum(FAILURE_TYPES),
  summary: z.string().max(2000),
})
export type RecoveryFailure = z.infer<typeof recoveryFailureSchema>
export const recoveryStateSchema = z.object({
  required: z.boolean(),
  status: z.enum(['pending', 'repairing', 'resolved', 'stale', 'needs_human_attention']),
  projectId: z.string().uuid(), checkpointId: z.string().uuid(),
  localSha: shaSchema, remoteSha: shaSchema.nullable(),
  validationId: z.string().min(1).max(200), environment: turnEnvironmentSchema,
  failures: z.array(recoveryFailureSchema).min(1).max(30),
  evidence: z.string().max(8000), observedAt: z.string().datetime(),
  freshness: z.enum(['current', 'stale', 'offline', 'unknown']),
  reason: z.string().max(500).nullable(),
  attempts: z.number().int().nonnegative(), maxAttempts: z.number().int().min(1).max(10),
  targetFingerprint: fingerprintSchema.nullable(),
  targetHeadSha: shaSchema,
  attemptFingerprint: fingerprintSchema.nullable(), attemptHeadSha: shaSchema.nullable(),
  attemptStartedAt: z.string().datetime().nullable(),
  resolvedValidationId: z.string().max(200).nullable(),
}).superRefine((value, context) => {
  if (value.required === (value.status === 'resolved')) {
    context.addIssue({ code: 'custom', message: 'Somente recovery comprovadamente resolvido deixa de ser obrigatório.' })
  }
})
export type RecoveryState = z.infer<typeof recoveryStateSchema>

/** A criterion describes observable behavior; its proof names are chosen by the implementing agent. */
export const acceptanceCriterionSchema = z.object({
  id: z.string().min(1).max(100), description: z.string().min(1).max(2000),
  requiredChecks: z.array(z.string().min(1).max(200)).min(1).max(30),
})
export type AcceptanceCriterion = z.infer<typeof acceptanceCriterionSchema>
export const validationEvidenceSchema = z.object({
  validationId: z.string().min(1).max(200), projectId: z.string().uuid(),
  checkpointId: z.string().uuid().nullable(),
  localSha: shaSchema, remoteSha: shaSchema.nullable(), fingerprint: fingerprintSchema,
  workspaceHeadSha: shaSchema.optional(),
  environment: turnEnvironmentSchema, source: z.enum(['local', 'remote']),
  status: z.enum(['pending', 'running', 'passed', 'failed', 'stale']),
  startedAt: z.string().datetime(), completedAt: z.string().datetime().nullable(),
  checks: z.array(z.object({
    name: z.string().min(1).max(200), type: z.enum(FAILURE_TYPES),
    status: z.enum(['passed', 'failed', 'skipped', 'pending']),
    evidence: z.string().max(8000),
  })).max(100),
  criterionIds: z.array(z.string().min(1).max(100)).max(100),
})
export type ValidationEvidence = z.infer<typeof validationEvidenceSchema>

export interface TurnContext {
  project: string
  projectId: string
  repository: string | null
  currentRef: string
  workspace: WorkspaceSnapshot
  environment: TurnEnvironment
  databaseEnvironment: TurnEnvironment
  databaseAuthority: 'authorized' | 'blocked' | 'unknown'
  preview: { url: string | null; healthy: boolean }
  daemon: { running: boolean }
  latestCheckpoint: CheckpointLink | null
  pendingRecovery: RecoveryState | null
  pendingValidation: ValidationEvidence[]
  securityState: 'safe' | 'unsafe' | 'unknown'
  integrationMode: IntegrationMode
  reconciliation: { status: 'fresh' | 'offline' | 'invalid'; observedAt: string }
}

export const turnStateSchema = z.object({
  version: z.literal(1), turnId: z.string().uuid(), projectId: z.string().uuid(),
  environment: turnEnvironmentSchema, phase: z.enum(TURN_PHASES),
  startedAt: z.string().datetime(), updatedAt: z.string().datetime(),
  workspace: workspaceSnapshotSchema, recovery: recoveryStateSchema.nullable(),
  acceptanceCriteria: z.array(acceptanceCriterionSchema).max(100),
  validations: z.array(validationEvidenceSchema).max(100),
  checkpointId: z.string().uuid().nullable(),
  integrationMode: z.enum(['enforced', 'assisted', 'unsupported']),
  status: z.enum(['active', 'completed', 'blocked']),
})
export type TurnState = z.infer<typeof turnStateSchema>

export function classifyFailure(name: string, category?: 'code' | 'security' | 'infrastructure'): FailureType {
  if (category === 'infrastructure') return 'external_dependency'
  if (/\brls\b|row.level|isola(?:tion|mento)/i.test(name)) return 'rls'
  if (category === 'security' || /security|seguran|vulnerab|secrets?|audit/i.test(name)) return 'security'
  if (/type.?check|typescript|tipagem|\btsc\b/i.test(name)) return 'typecheck'
  if (/lint|eslint/i.test(name)) return 'lint'
  if (/migrat|migra[çc]/i.test(name)) return 'migration'
  if (/\be2e\b|end.to.end|playwright|browser/i.test(name)) return 'e2e'
  if (/integration|integra[çc]/i.test(name)) return 'integration'
  if (/unit|vitest|coverage|cobertura|testes?/i.test(name)) return 'unit'
  if (/build|compil/i.test(name)) return 'build'
  if (/runtime|exception/i.test(name)) return 'runtime'
  if (/environment|ambiente|configuration|configura/i.test(name)) return 'environment'
  return category === 'code' ? 'code' : 'unknown'
}

function repairLimit(input: number | undefined): number {
  return input === undefined ? DEFAULT_MAX_AUTO_REPAIR_ATTEMPTS : z.number().int().min(1).max(10).parse(input)
}

function feedbackLink(feedback: ValidationFeedback, queue: readonly CheckpointLink[], workspace: WorkspaceSnapshot): CheckpointLink | null {
  return queue.find((record) => record.checkpointId === feedback.checkpointId &&
    record.projectId === feedback.projectId && record.projectId === workspace.projectId &&
    record.commitSha === feedback.commitSha && record.environment === workspace.environment &&
    (record.publishedSha === null || record.publishedSha === feedback.publishedSha)) ?? null
}

function currentRecovery(recovery: RecoveryState, workspace: WorkspaceSnapshot, link: CheckpointLink | null): RecoveryState {
  // A failed, verified attempt may retry its current target, while retaining the original failure ID and attempt budget.
  if (recovery.reason === 'repair_not_verified' && recovery.projectId === workspace.projectId && recovery.environment === workspace.environment && recovery.targetFingerprint === workspace.fingerprint && recovery.targetHeadSha === workspace.headSha) return { ...recovery, freshness: 'current' }
  const matches = recovery.projectId === workspace.projectId && recovery.environment === workspace.environment &&
    link !== null && ((link.fingerprint !== undefined ? link.fingerprint === workspace.fingerprint : link.commitSha === workspace.headSha && !workspace.dirty) ||
      (recovery.attempts > 0 && recovery.targetFingerprint === workspace.fingerprint && recovery.targetHeadSha === workspace.headSha))
  if (!matches) return { ...recovery, required: true, status: 'stale', freshness: 'stale', reason: 'checkpoint_or_workspace_changed' }
  if (recovery.targetFingerprint !== null && recovery.targetFingerprint !== workspace.fingerprint) {
    return { ...recovery, required: true, status: 'stale', freshness: 'stale', reason: 'workspace_fingerprint_changed' }
  }
  return { ...recovery, freshness: 'current', reason: null, targetFingerprint: workspace.fingerprint, targetHeadSha: workspace.headSha,
    status: recovery.status === 'stale' ? 'pending' : recovery.status }
}

export interface ReconcileRecoveryInput {
  workspace: WorkspaceSnapshot
  queue: readonly CheckpointLink[]
  feedback: FeedbackEnvelope | null
  previous: RecoveryState | null
  remoteStatus: 'fresh' | 'offline' | 'invalid'
  now: string
  maxAttempts?: number
}

/**
 * A backend read is mandatory per turn; absence/offline never resolves a failure.
 * Local and published SHAs are deliberately distinct. Only a project/environment
 * checkpoint mapping can translate remote evidence into a local target.
 */
export function reconcileRecovery(input: ReconcileRecoveryInput): RecoveryState | null {
  const workspace = workspaceSnapshotSchema.parse(input.workspace)
  const maxAttempts = repairLimit(input.maxAttempts)
  const prior = input.previous ? recoveryStateSchema.parse(input.previous) : null
  if (prior && prior.projectId !== workspace.projectId) throw new Error('Recovery pertence a outro projeto.')
  if (input.remoteStatus !== 'fresh') {
    // A cold start may discover persisted evidence before ever having a TurnState.
    // Keep it visible, without granting stale/offline evidence authority to repair or resolve.
    const observed = prior?.required ? prior : reconcileRecovery({ ...input, remoteStatus: 'fresh' })
    if (!observed || !observed.required) return prior
    return { ...observed, freshness: input.remoteStatus === 'offline' ? 'offline' : 'unknown', reason: `feedback_${input.remoteStatus}` }
  }
  const parsed = feedbackEnvelopeSchema.safeParse(input.feedback)
  if (!parsed.success || [parsed.data.current, parsed.data.previousFailure].some((item) => item && item.projectId !== workspace.projectId)) {
    return prior && prior.required ? { ...prior, freshness: 'unknown', reason: 'feedback_invalid' } : null
  }
  const { current, previousFailure } = parsed.data
  if (current && (current.state === 'passed' || current.state === 'integrated') && prior?.required &&
    current.checkpointId === prior.checkpointId && current.commitSha === prior.localSha &&
    current.publishedSha === prior.remoteSha && current.observedAt >= prior.observedAt &&
    feedbackLink(current, input.queue, workspace) &&
    currentRecovery(prior, workspace, feedbackLink(current, input.queue, workspace)).freshness === 'current') {
    return { ...prior, status: 'resolved', required: false, freshness: 'current', reason: null,
      observedAt: current.observedAt,
      resolvedValidationId: `${current.checkpointId}:${current.observedAt}` }
  }
  const failure = [current, previousFailure].filter((item): item is ValidationFeedback => item?.state === 'failed')
    .sort((a, b) => b.observedAt.localeCompare(a.observedAt))[0]
  if (!failure || (prior && failure.observedAt < prior.observedAt)) {
    if (!prior || !prior.required) return prior
    const link = input.queue.find((record) => record.checkpointId === prior.checkpointId &&
      record.projectId === workspace.projectId && record.environment === workspace.environment && record.commitSha === prior.localSha) ?? null
    return currentRecovery(prior, workspace, link)
  }
  const sameFailure = prior?.checkpointId === failure.checkpointId && prior.localSha === failure.commitSha && prior.remoteSha === failure.publishedSha
  // A replay of evidence preceding an already verified repair cannot reopen it.
  if (sameFailure && prior.status === 'resolved' && failure.observedAt <= prior.observedAt) return prior
  const recovery: RecoveryState = {
    required: true, status: sameFailure && prior.required ? prior.status : 'pending',
    projectId: failure.projectId, checkpointId: failure.checkpointId,
    localSha: failure.commitSha, remoteSha: failure.publishedSha,
    validationId: `${failure.checkpointId}:${failure.observedAt}`, environment: workspace.environment,
    failures: failure.failures.length ? failure.failures.map((item) => ({
      name: sanitizeDiagnostic(item.name).slice(0, 200), type: classifyFailure(item.name, item.category),
      summary: sanitizeDiagnostic(failure.summary).slice(0, 2000),
    })) : [{ name: 'unknown', type: 'unknown', summary: sanitizeDiagnostic(failure.summary).slice(0, 2000) }],
    evidence: sanitizeDiagnostic(failure.evidence), observedAt: failure.observedAt,
    freshness: 'current', reason: sameFailure ? prior.reason : null, attempts: sameFailure ? prior.attempts : 0,
    maxAttempts: sameFailure ? prior.maxAttempts : maxAttempts,
    targetFingerprint: sameFailure ? prior.targetFingerprint : null,
    targetHeadSha: sameFailure ? prior.targetHeadSha : workspace.headSha,
    attemptFingerprint: sameFailure ? prior.attemptFingerprint : null,
    attemptHeadSha: sameFailure ? prior.attemptHeadSha : null,
    attemptStartedAt: sameFailure ? prior.attemptStartedAt : null,
    resolvedValidationId: null,
  }
  const linked = currentRecovery(recovery, workspace, feedbackLink(failure, input.queue, workspace))
  if (Date.parse(failure.observedAt) > Date.parse(input.now) + 60_000) {
    return { ...linked, status: 'stale', freshness: 'unknown', reason: 'feedback_from_future' }
  }
  if (linked.status !== 'stale' && linked.attempts >= linked.maxAttempts) {
    return { ...linked, status: 'needs_human_attention', reason: 'repair_limit_reached' }
  }
  return linked
}

const PROTECTED_REPAIR_PATHS = [
  /(^|\/)(?:\.git|\.supremo|\.codex|\.claude|\.agents)(?:\/|$)/,
  /(^|\/)(?:node_modules|\.next|coverage|test-results|playwright-report)(?:\/|$)/,
  /(^|\/)(?:\.gitignore|\.npmrc|\.yarnrc(?:\.yml)?|\.eslintrc(?:\.[^/]*)?|\.eslintignore|biome\.jsonc?|Dockerfile|\.dockerignore)$/,
  /(^|\/)supabase\/config\.toml$/,
  /(^|\/)(?:AGENTS|CLAUDE)\.md$/i,
  /(^|\/)\.github(?:\/|$)/,
  /(^|\/)(?:package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/,
  /(^|\/)(?:vitest|jest|playwright|eslint|next|tsconfig|vercel)(?:\.[^/]*)?\.(?:[cm]?[jt]s|json)$/,
  /(^|\/)(?:supabase\/migrations|scripts)(?:\/|$)/,
  /(^|\/)(?:tests?|__tests__|__snapshots__)(?:\/|$)/,
  /\.(?:test|spec)\.[cm]?[jt]sx?$/,
  /(^|\/)\.env(?:\.|$)/,
]

/** Repair may fix implementation; modifying its own gates requires human review. */
export function canAutoRepairPaths(paths: readonly string[]): boolean {
  return paths.every((raw) => {
    const normalized = raw.replace(/\\/g, '/').replace(/^\.\//, '')
    return normalized.length > 0 && !normalized.startsWith('/') &&
      !normalized.split('/').some((part) => part === '..' || part === '') &&
      !PROTECTED_REPAIR_PATHS.some((pattern) => pattern.test(normalized))
  })
}

/** Extract only the documented file directives; ambiguous patch syntax fails closed. */
export function repairPatchPaths(patch: string): string[] | null {
  const lines = patch.trim().split(/\r?\n/)
  if (lines[0] !== '*** Begin Patch' || lines.at(-1) !== '*** End Patch') return null
  const paths: string[] = []
  let current: 'Add' | 'Update' | 'Delete' | null = null
  for (const line of lines.slice(1, -1)) {
    const file = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line)
    if (file) { paths.push(file[2]!); current = file[1] as 'Add' | 'Update' | 'Delete'; continue }
    const move = /^\*\*\* Move to: (.+)$/.exec(line)
    if (move) {
      if (current !== 'Update') return null
      paths.push(move[1]!); continue
    }
    if (line.startsWith('***') && line !== '*** End of File') return null
    if (current === null) return null
  }
  return paths.length ? paths : null
}

/** A deliberately small shell grammar for Codex diagnostics; no expansions or command composition. */
export function isReadOnlyDiagnostic(command: string): boolean {
  if (!command.trim() || /[\\$`;&|<>\r\n(){}]/.test(command)) return false
  const tokens: string[] = []
  let token = ''
  let quote: '"' | "'" | null = null
  for (const char of command.trim()) {
    if (quote !== null) { if (char === quote) quote = null; else token += char; continue }
    if (char === '"' || char === "'") { quote = char; continue }
    if (/\s/.test(char)) { if (token) { tokens.push(token); token = '' }; continue }
    if (char === '#') return false
    token += char
  }
  if (quote !== null) return false
  if (token) tokens.push(token)
  const [binary, ...args] = tokens
  if (binary === 'pwd') return args.length === 0
  if (['cat', 'head', 'tail', 'wc', 'ls'].includes(binary ?? '')) return true
  if (binary === 'rg') return args.includes('--no-config') &&
    !args.some((arg) => /^--(?:pre|pre-glob|hostname-bin|hyperlink-format)(?:=|$)/.test(arg))
  if (binary === 'sed') return args[0] === '-n' && /^\d+(?:,\d+)?p$/.test(args[1] ?? '') &&
    args.length >= 3 && args.slice(2).every((arg) => !arg.startsWith('-'))
  return false
}

export interface RepairDecision { allowed: boolean; recovery: RecoveryState; reason: string | null }
export function beginRepair(recovery: RecoveryState, input: {
  workspace: WorkspaceSnapshot
  activeTurnId: string | null
  requestingTurnId: string | null
  now: string
  changedPaths?: readonly string[]
}): RepairDecision {
  let reason: string | null = null
  if (!recovery.required || recovery.status === 'resolved') reason = 'already_resolved'
  else if (input.activeTurnId !== null && input.activeTurnId !== input.requestingTurnId) reason = 'workspace_busy'
  else if (input.workspace.environment !== 'development' || recovery.environment !== 'development') reason = 'development_required'
  else if (recovery.freshness !== 'current' || recovery.status === 'stale') reason = 'recovery_not_current'
  else if (recovery.status === 'repairing') reason = 'repair_already_running'
  else if (recovery.projectId !== input.workspace.projectId || recovery.targetHeadSha !== input.workspace.headSha ||
    recovery.targetFingerprint !== input.workspace.fingerprint) reason = 'workspace_changed'
  else if (recovery.attempts >= recovery.maxAttempts) reason = 'repair_limit_reached'
  else if (recovery.failures.some((failure) => ['environment', 'external_dependency', 'unknown'].includes(failure.type))) reason = 'diagnosis_requires_human'
  else if (input.changedPaths && !canAutoRepairPaths(input.changedPaths)) reason = 'protected_paths'
  if (reason) {
    const needsHuman = ['development_required', 'repair_limit_reached', 'diagnosis_requires_human', 'protected_paths'].includes(reason)
    return { allowed: false, reason, recovery: needsHuman ? { ...recovery, status: 'needs_human_attention', reason } : recovery }
  }
  return { allowed: true, reason: null, recovery: { ...recovery, status: 'repairing', attempts: recovery.attempts + 1,
    attemptFingerprint: input.workspace.fingerprint, attemptHeadSha: input.workspace.headSha, attemptStartedAt: z.string().datetime().parse(input.now), reason: null } }
}

export function validationEvidenceMatches(evidence: ValidationEvidence, workspace: WorkspaceSnapshot): boolean {
  return evidence.projectId === workspace.projectId && evidence.environment === workspace.environment &&
    (evidence.localSha === workspace.headSha || evidence.workspaceHeadSha === workspace.headSha) && evidence.fingerprint === workspace.fingerprint
}

export function acceptanceSatisfied(criteria: readonly AcceptanceCriterion[], evidence: ValidationEvidence): boolean {
  return criteria.every((criterion) => evidence.criterionIds.includes(criterion.id) &&
    criterion.requiredChecks.every((required) => evidence.checks.some((check) => check.name === required && check.status === 'passed' && check.evidence.trim().length > 0)))
}

/** A failed/incomplete repair remains open. A changed workspace invalidates proof. */
export function finishRepair(recovery: RecoveryState, input: {
  workspace: WorkspaceSnapshot
  evidence: ValidationEvidence
  acceptanceCriteria: readonly AcceptanceCriterion[]
  changedPaths: readonly string[]
}): RecoveryState {
  if (recovery.status !== 'repairing') throw new Error('Recovery não está em reparo.')
  const evidence = validationEvidenceSchema.parse(input.evidence)
  if (!validationEvidenceMatches(evidence, input.workspace) || evidence.projectId !== recovery.projectId ||
    evidence.environment !== recovery.environment || recovery.attemptStartedAt === null ||
    Date.parse(evidence.startedAt) < Date.parse(recovery.attemptStartedAt)) {
    return { ...recovery, status: 'stale', freshness: 'stale', reason: 'repair_evidence_mismatch' }
  }
  if (!canAutoRepairPaths(input.changedPaths)) {
    return { ...recovery, status: 'needs_human_attention', reason: 'protected_paths' }
  }
  const requiredTypes = new Set<FailureType>(recovery.failures.map((failure) => failure.type))
  if (requiredTypes.delete('code')) { requiredTypes.add('unit'); requiredTypes.add('typecheck') }
  if (requiredTypes.has('rls') || requiredTypes.has('security') || requiredTypes.has('migration')) {
    requiredTypes.add('security'); requiredTypes.add('rls')
  }
  const success = evidence.status === 'passed' && evidence.completedAt !== null &&
    Date.parse(evidence.completedAt) >= Date.parse(evidence.startedAt) && evidence.checks.length > 0 &&
    evidence.checks.every((check) => check.status === 'passed' && check.evidence.trim().length > 0) &&
    [...requiredTypes].every((type) => evidence.checks.some((check) => check.type === type)) &&
    acceptanceSatisfied(input.acceptanceCriteria, evidence)
  if (!success) return { ...recovery, status: recovery.attempts >= recovery.maxAttempts ? 'needs_human_attention' : 'pending',
    reason: 'repair_not_verified', targetFingerprint: input.workspace.fingerprint, targetHeadSha: input.workspace.headSha }
  return { ...recovery, required: false, status: 'resolved', freshness: 'current', reason: null,
    observedAt: evidence.completedAt!, resolvedValidationId: evidence.validationId }
}

const BROWSER_ACTIONS = ['open', 'click', 'fill', 'navigate', 'mobile', 'console', 'requests'] as const
export function browserQaPolicy(input: {
  environment: TurnEnvironment; url: string; syntheticUsers: boolean; action: string
}): { allowed: boolean; reason: string | null } {
  if (input.environment !== 'development' || !input.syntheticUsers) return { allowed: false, reason: 'development_test_users_required' }
  if (!(BROWSER_ACTIONS as readonly string[]).includes(input.action)) return { allowed: false, reason: 'sensitive_action' }
  try {
    const url = new URL(input.url)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return { allowed: false, reason: 'local_preview_required' }
  } catch { return { allowed: false, reason: 'invalid_preview_url' } }
  return { allowed: true, reason: null }
}

/** HMR stays available in every state; only validated/integratable health changes. */
export function deriveProjectHealth(input: {
  recovery: RecoveryState | null
  validations: readonly ValidationEvidence[]
  workspace: WorkspaceSnapshot
  securityState: TurnContext['securityState']
  remoteStatus: TurnContext['reconciliation']['status']
  activeTurn: boolean
}): ProjectHealth {
  if (input.securityState === 'unsafe' || input.remoteStatus === 'invalid') return 'blocked'
  if (input.recovery?.required) {
    if (input.recovery.status === 'repairing') return 'repairing'
    return input.recovery.status === 'needs_human_attention' || input.recovery.status === 'stale' ? 'needs_attention' : 'blocked'
  }
  if (input.activeTurn) return 'developing'
  if (input.remoteStatus !== 'fresh') return 'validating'
  const matching = input.validations.filter((evidence) => validationEvidenceMatches(evidence, input.workspace))
  if (matching.some((evidence) => evidence.status === 'failed')) return 'blocked'
  if (input.workspace.dirty && !matching.length) return 'developing'
  if (input.securityState !== 'safe') return 'validating'
  if (!matching.length || matching.some((evidence) => evidence.status !== 'passed')) return 'validating'
  return 'healthy'
}

/** Minimal executable transitions; a host cannot skip preflight or open recovery. */
export function transitionTurn(state: TurnState, phase: TurnPhase, now: string): TurnState {
  const allowed: Record<TurnPhase, readonly TurnPhase[]> = {
    preflight: ['work', 'recovery'], work: ['background_validation', 'postflight'],
    background_validation: ['work', 'postflight', 'recovery'],
    postflight: ['background_validation', 'recovery'], recovery: ['work', 'background_validation'],
  }
  if (!allowed[state.phase].includes(phase)) throw new Error(`Transição de turno inválida: ${state.phase} → ${phase}.`)
  if (phase === 'work' && state.recovery?.required) throw new Error('Recovery pendente deve ser comprovadamente resolvido antes do pedido novo.')
  return { ...state, phase, updatedAt: now }
}
