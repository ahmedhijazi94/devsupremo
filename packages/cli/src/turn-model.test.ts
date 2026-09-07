import { describe, expect, it } from 'vitest'
import type { FeedbackEnvelope, ValidationFeedback } from '../../../src/lib/checkpoint/feedback'
import {
  acceptanceSatisfied, beginRepair, browserQaPolicy, canAutoRepairPaths, classifyFailure,
  deriveProjectHealth, finishRepair, reconcileRecovery, recoveryStateSchema,
  transitionTurn, turnStateSchema, validationEvidenceMatches, repairPatchPaths, isReadOnlyDiagnostic,
  type CheckpointLink, type RecoveryState, type TurnState, type ValidationEvidence, type WorkspaceSnapshot,
} from './turn-model'

const PROJECT = 'b0880ad1-019b-4494-bd48-c3685bd51548'
const OTHER_PROJECT = '223d7743-4aa1-4153-9bea-df4f737bac18'
const CHECKPOINT = '935122ff-ee82-49a8-a6b4-317e33b6bdc5'
const NEXT_CHECKPOINT = '724c1597-c374-42fe-ad68-2ebd4bd0ae6d'
const TURN = '720c10c8-ccf5-4bb4-b747-f2327d80a6ec'
const LOCAL = 'a'.repeat(40)
const REMOTE = 'b'.repeat(40)
const HEAD = 'c'.repeat(40)
const NEXT = 'd'.repeat(40)
const OBSERVED = '2026-09-06T10:00:00.000Z'
const NOW = '2026-09-06T10:01:00.000Z'
const LATER = '2026-09-06T10:02:00.000Z'
const workspace: WorkspaceSnapshot = { projectId: PROJECT, environment: 'development', headSha: LOCAL, fingerprint: 'tree-a', dirty: false }
const checkpoint: CheckpointLink = {
  projectId: PROJECT, checkpointId: CHECKPOINT, environment: 'development',
  commitSha: LOCAL, publishedSha: REMOTE, createdAt: OBSERVED,
}
const feedback: ValidationFeedback = {
  projectId: PROJECT, checkpointId: CHECKPOINT, commitSha: LOCAL, publishedSha: REMOTE,
  state: 'failed', failures: [{ name: 'E2E browser', category: 'code' }],
  observedAt: OBSERVED, summary: 'Ticket owner cannot read a ticket.', evidence: 'Expected ticket title, got forbidden.',
}
const envelope: FeedbackEnvelope = { current: feedback, previousFailure: null }
function pending(overrides: Partial<RecoveryState> = {}): RecoveryState {
  const result = reconcileRecovery({ workspace, queue: [checkpoint], feedback: envelope, previous: null, remoteStatus: 'fresh', now: NOW })
  if (!result) throw new Error('Expected pending recovery')
  return { ...result, ...overrides }
}
function repairing(overrides: Partial<RecoveryState> = {}): RecoveryState {
  return beginRepair(pending(overrides), { workspace, activeTurnId: TURN, requestingTurnId: TURN, now: NOW }).recovery
}
function evidence(overrides: Partial<ValidationEvidence> = {}): ValidationEvidence {
  return {
    validationId: 'validation-repair-1', projectId: PROJECT, checkpointId: NEXT_CHECKPOINT,
    localSha: LOCAL, remoteSha: null, fingerprint: 'tree-a', environment: 'development', source: 'local',
    status: 'passed', startedAt: NOW, completedAt: LATER,
    checks: [{ name: 'ticket ownership', type: 'e2e', status: 'passed', evidence: 'A owns ticket; B receives 403.' }],
    criterionIds: ['owner-isolation'], ...overrides,
  }
}
const criteria = [{ id: 'owner-isolation', description: 'Only the owner can read, change, or delete tickets.', requiredChecks: ['ticket ownership'] }]
function complete(recovery: RecoveryState, validation: ValidationEvidence = evidence()): RecoveryState {
  return finishRepair(recovery, { workspace, evidence: validation, acceptanceCriteria: criteria, changedPaths: ['src/actions/ticket.ts'] })
}

describe('reconciliation binds backend feedback to the actual local project snapshot', () => {
  it('delivers a backend failure even when the daemon cache has not received it', () => {
    const result = pending()
    expect(result).toMatchObject({ required: true, status: 'pending', freshness: 'current', localSha: LOCAL, remoteSha: REMOTE,
      checkpointId: CHECKPOINT, maxAttempts: 3, attempts: 0, targetFingerprint: 'tree-a' })
    expect(result.validationId).toContain(CHECKPOINT)
  })

  it('maps immutable snapshot fingerprints while the live HEAD remains an ancestor and the tree is dirty', () => {
    const live = { ...workspace, headSha: HEAD, dirty: true }
    const result = reconcileRecovery({ workspace: live, queue: [{ ...checkpoint, fingerprint: 'tree-a' }],
      feedback: envelope, previous: null, remoteStatus: 'fresh', now: NOW })
    expect(result).toMatchObject({ status: 'pending', localSha: LOCAL, targetHeadSha: HEAD })
    expect(beginRepair(result!, { workspace: live, activeTurnId: null, requestingTurnId: null, now: NOW }).allowed).toBe(true)
  })

  it('does not confuse the remote published SHA with the local commit', () => {
    const result = reconcileRecovery({ workspace: { ...workspace, headSha: REMOTE }, queue: [checkpoint], feedback: envelope,
      previous: null, remoteStatus: 'fresh', now: NOW })
    expect(result).toMatchObject({ required: true, status: 'stale' })
  })

  it.each([
    ['wrong local SHA', { ...checkpoint, commitSha: NEXT }],
    ['wrong remote SHA', { ...checkpoint, publishedSha: NEXT }],
    ['wrong environment', { ...checkpoint, environment: 'production' as const }],
    ['wrong project', { ...checkpoint, projectId: OTHER_PROJECT }],
    ['wrong checkpoint', { ...checkpoint, checkpointId: NEXT_CHECKPOINT }],
  ])('keeps %s unrepairable', (_name, record) => {
    const result = reconcileRecovery({ workspace, queue: [record], feedback: envelope, previous: null, remoteStatus: 'fresh', now: NOW })
    expect(result).toMatchObject({ required: true, freshness: 'stale', status: 'stale' })
  })

  it('does not trust another project supplied by the backend', () => {
    expect(reconcileRecovery({ workspace, queue: [checkpoint], feedback: { current: { ...feedback, projectId: OTHER_PROJECT }, previousFailure: null },
      previous: null, remoteStatus: 'fresh', now: NOW })).toBeNull()
    expect(() => reconcileRecovery({ workspace, queue: [checkpoint], feedback: envelope,
      previous: pending({ projectId: OTHER_PROJECT }), remoteStatus: 'fresh', now: NOW })).toThrow(/outro projeto/)
  })

  it('keeps a late failure for checkpoint A stale while checkpoint B is pending', () => {
    const result = reconcileRecovery({ workspace: { ...workspace, headSha: NEXT, fingerprint: 'tree-next' },
      queue: [checkpoint, { ...checkpoint, checkpointId: NEXT_CHECKPOINT, commitSha: NEXT, publishedSha: null }],
      feedback: { current: { ...feedback, checkpointId: NEXT_CHECKPOINT, commitSha: NEXT, state: 'pending', failures: [], observedAt: NOW }, previousFailure: feedback },
      previous: null, remoteStatus: 'fresh', now: NOW })
    expect(result).toMatchObject({ checkpointId: CHECKPOINT, localSha: LOCAL, required: true, status: 'stale' })
  })

  it('preserves failed state offline across a new process and reconciles later', () => {
    const persisted = recoveryStateSchema.parse(JSON.parse(JSON.stringify(pending())))
    const offline = reconcileRecovery({ workspace, queue: [], feedback: null, previous: persisted, remoteStatus: 'offline', now: NOW })
    expect(offline).toMatchObject({ required: true, checkpointId: CHECKPOINT, freshness: 'offline', attempts: 0 })
    expect(beginRepair(offline!, { workspace, activeTurnId: null, requestingTurnId: null, now: NOW }).allowed).toBe(false)
    const fresh = reconcileRecovery({ workspace, queue: [checkpoint], feedback: envelope, previous: offline, remoteStatus: 'fresh', now: NOW })
    expect(fresh).toMatchObject({ required: true, freshness: 'current', checkpointId: CHECKPOINT })
  })

  it('keeps cached failure explicit during the first offline preflight without granting repair authority', () => {
    const recovery = reconcileRecovery({ workspace, queue: [checkpoint], feedback: envelope, previous: null,
      remoteStatus: 'offline', now: NOW })
    expect(recovery).toMatchObject({ required: true, freshness: 'offline', checkpointId: CHECKPOINT })
    expect(beginRepair(recovery!, { workspace, activeTurnId: TURN, requestingTurnId: TURN, now: NOW }).allowed).toBe(false)
  })

  it('a missing remote failure never proves recovery', () => {
    const result = reconcileRecovery({ workspace, queue: [checkpoint], feedback: { current: null, previousFailure: null },
      previous: pending(), remoteStatus: 'fresh', now: NOW })
    expect(result).toMatchObject({ required: true, status: 'pending' })
  })

  it('a rerun passing the same mapped checkpoint can resolve it', () => {
    const result = reconcileRecovery({ workspace, queue: [checkpoint], feedback: { current: { ...feedback, state: 'passed', observedAt: NOW, failures: [] }, previousFailure: null },
      previous: pending(), remoteStatus: 'fresh', now: NOW })
    expect(result).toMatchObject({ required: false, status: 'resolved', observedAt: NOW })
    expect(reconcileRecovery({ workspace, queue: [checkpoint], feedback: envelope, previous: result, remoteStatus: 'fresh', now: NOW })).toEqual(result)
  })

  it('a later green result for another checkpoint cannot silently close a failure', () => {
    expect(reconcileRecovery({ workspace, queue: [checkpoint], feedback: { current: { ...feedback, checkpointId: NEXT_CHECKPOINT, state: 'passed', observedAt: NOW }, previousFailure: null },
      previous: pending(), remoteStatus: 'fresh', now: NOW })?.required).toBe(true)
  })

  it('timestamp rollback cannot erase a more recent failure', () => {
    const recent = pending({ observedAt: NOW, attempts: 2 })
    expect(reconcileRecovery({ workspace, queue: [checkpoint], feedback: envelope, previous: recent, remoteStatus: 'fresh', now: NOW }))
      .toMatchObject({ observedAt: NOW, attempts: 2, required: true })
  })

  it('rejects observations from the future and detects edits between preflights', () => {
    const future = reconcileRecovery({ workspace, queue: [checkpoint], feedback: { current: { ...feedback, observedAt: '2026-09-07T00:00:00.000Z' }, previousFailure: null },
      previous: null, remoteStatus: 'fresh', now: NOW })
    expect(future).toMatchObject({ status: 'stale', freshness: 'unknown' })
    expect(reconcileRecovery({ workspace: { ...workspace, fingerprint: 'unrecorded-tree' }, queue: [checkpoint],
      feedback: envelope, previous: pending(), remoteStatus: 'fresh', now: NOW })).toMatchObject({ status: 'stale', reason: 'workspace_fingerprint_changed' })
  })

  it('sanitizes credentials before writing recovery evidence', () => {
    // Synthetic token, constructed at runtime so the fixture is not a stored credential.
    const secret = 'ghp_' + 'a'.repeat(36)
    const result = reconcileRecovery({ workspace, queue: [checkpoint], feedback: { current: { ...feedback, evidence: `Authorization: ${secret}\nhttps://host/path?token=secret`, summary: `token=${secret}` }, previousFailure: null },
      previous: null, remoteStatus: 'fresh', now: NOW })
    expect(JSON.stringify(result)).not.toContain(secret)
    expect(result?.evidence).not.toContain('token=secret')
  })
})

describe('safe bounded repair controller', () => {
  it('claims one repair at a time and records attempts before mutation', () => {
    const result = beginRepair(pending(), { workspace, activeTurnId: TURN, requestingTurnId: TURN, now: NOW })
    expect(result).toMatchObject({ allowed: true, recovery: { status: 'repairing', attempts: 1, attemptHeadSha: LOCAL, attemptStartedAt: NOW } })
    expect(beginRepair(result.recovery, { workspace, activeTurnId: TURN, requestingTurnId: TURN, now: NOW }).reason).toBe('repair_already_running')
  })

  it('queues recovery when another turn owns the workspace', () => {
    const result = beginRepair(pending(), { workspace, activeTurnId: 'another-turn', requestingTurnId: TURN, now: NOW })
    expect(result).toMatchObject({ allowed: false, reason: 'workspace_busy', recovery: { attempts: 0, status: 'pending' } })
  })

  it.each(['production', 'unknown'] as const)('does not repair %s', (environment) => {
    expect(beginRepair(pending({ environment }), { workspace: { ...workspace, environment }, activeTurnId: null, requestingTurnId: null, now: NOW }))
      .toMatchObject({ allowed: false, recovery: { status: 'needs_human_attention' } })
  })

  it.each(['environment', 'external_dependency', 'unknown'] as const)('escalates %s failures rather than changing code blindly', (type) => {
    expect(beginRepair(pending({ failures: [{ name: type, type, summary: 'Failed' }] }), { workspace, activeTurnId: null, requestingTurnId: null, now: NOW }))
      .toMatchObject({ allowed: false, reason: 'diagnosis_requires_human' })
  })

  it('rejects mutation when the tree changed after preflight', () => {
    expect(beginRepair(pending(), { workspace: { ...workspace, fingerprint: 'new-content' }, activeTurnId: null, requestingTurnId: null, now: NOW }))
      .toMatchObject({ allowed: false, reason: 'workspace_changed' })
  })

  it('resolves only a passing proof for the repaired tree and acceptance criteria', () => {
    const resolved = complete(repairing())
    expect(resolved).toMatchObject({ required: false, status: 'resolved', resolvedValidationId: 'validation-repair-1', attempts: 1, observedAt: LATER })
    expect(recoveryStateSchema.parse(JSON.parse(JSON.stringify(resolved)))).toEqual(resolved)
  })

  it('supports a repaired immutable snapshot without moving the live HEAD', () => {
    const live = { ...workspace, headSha: HEAD, fingerprint: 'repaired-tree', dirty: true }
    const proof = evidence({ localSha: NEXT, workspaceHeadSha: HEAD, fingerprint: 'repaired-tree' })
    expect(validationEvidenceMatches(proof, live)).toBe(true)
    expect(finishRepair(repairing(), { workspace: live, evidence: proof, acceptanceCriteria: criteria, changedPaths: ['src/actions/ticket.ts'] }).status).toBe('resolved')
  })

  it.each([
    ['wrong project', evidence({ projectId: OTHER_PROJECT })],
    ['wrong environment', evidence({ environment: 'production' })],
    ['wrong SHA', evidence({ localSha: NEXT })],
    ['wrong tree', evidence({ fingerprint: 'other-tree' })],
    ['before attempt', evidence({ startedAt: OBSERVED })],
  ])('rejects %s repair evidence', (_name, proof) => {
    expect(complete(repairing(), proof)).toMatchObject({ status: 'stale', required: true, reason: 'repair_evidence_mismatch' })
  })

  it.each([
    ['failed validation', evidence({ status: 'failed' })],
    ['no checks', evidence({ checks: [] })],
    ['no completed timestamp', evidence({ completedAt: null })],
    ['no acceptance proof', evidence({ criterionIds: [] })],
    ['warning instead of test', evidence({ checks: [{ name: 'ticket ownership', type: 'e2e', status: 'skipped', evidence: 'warning only' }] })],
    ['unrelated check', evidence({ checks: [{ name: 'ticket ownership', type: 'lint', status: 'passed', evidence: 'All lint checks passed' }] })],
    ['empty evidence', evidence({ checks: [{ name: 'ticket ownership', type: 'e2e', status: 'passed', evidence: '' }] })],
  ])('does not greenwash %s', (_name, proof) => {
    expect(complete(repairing(), proof)).toMatchObject({ required: true, status: 'pending', reason: 'repair_not_verified' })
  })

  it('requires RLS isolation and security gates for an authorization repair', () => {
    const repair = repairing({ failures: [{ name: 'RLS', type: 'rls', summary: 'Cross-user leak' }] })
    const rls = { name: 'ticket ownership', type: 'rls' as const, status: 'passed' as const, evidence: 'A owns; B cannot read/update/delete.' }
    expect(complete(repair, evidence({ checks: [rls] })).required).toBe(true)
    expect(complete(repair, evidence({ checks: [rls, { name: 'security gate', type: 'security', status: 'passed', evidence: 'No high or critical findings.' }] })).required).toBe(false)
  })

  it('stops after the configured number of failed attempts, including cold starts', () => {
    let recovery = pending({ maxAttempts: 2 })
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      recovery = beginRepair(recovery, { workspace, activeTurnId: TURN, requestingTurnId: TURN, now: NOW }).recovery
      expect(recovery.attempts).toBe(attempt)
      recovery = recoveryStateSchema.parse(JSON.parse(JSON.stringify(complete(recovery, evidence({ status: 'failed' })))))
    }
    expect(recovery).toMatchObject({ status: 'needs_human_attention', required: true, attempts: 2 })
    expect(beginRepair(recovery, { workspace, activeTurnId: null, requestingTurnId: null, now: NOW }).allowed).toBe(false)
  })

  it('preserves the failure checkpoint SHA during a failed attempt against a new snapshot', () => {
    const recovery = finishRepair(repairing(), { workspace: { ...workspace, headSha: NEXT, fingerprint: 'new-tree' },
      evidence: evidence({ localSha: NEXT, fingerprint: 'new-tree', status: 'failed' }), acceptanceCriteria: criteria, changedPaths: ['src/action.ts'] })
    expect(recovery).toMatchObject({ localSha: LOCAL, checkpointId: CHECKPOINT, targetHeadSha: NEXT, targetFingerprint: 'new-tree' })
    expect(beginRepair(recovery, { workspace: { ...workspace, headSha: NEXT, fingerprint: 'new-tree' }, activeTurnId: null, requestingTurnId: null, now: LATER }).allowed).toBe(true)
  })

  it('forbids resolving recovery without claiming an attempt', () => {
    expect(() => complete(pending())).toThrow(/não está em reparo/)
  })
})

describe('anti-greenwashing and development browser policies', () => {
  it.each(['cat src/card.ts', 'rg --no-config "card" src', "sed -n '1,120p' src/card.ts", 'head -n 30 tests/gate.test.ts'])('allows bounded diagnostic %s', (command) => {
    expect(isReadOnlyDiagnostic(command)).toBe(true)
  })
  it.each(['cat src/card.ts; rm tests/gate.ts', 'cat $(touch source.ts)', 'cat source.ts > tests/gate.ts',
    'rg --no-config --pre=sh src', "rg --no-config --p'r'e=sh src", 'rg needle src', "sed -n '1e touch source.ts' src/card.ts", "sed -n '1p' -f evil.sed src/card.ts"])(
    'blocks shell expansion or executable diagnostic option %s', (command) => { expect(isReadOnlyDiagnostic(command)).toBe(false) },
  )
  it('extracts every changed and moved patch path before authorizing a repair', () => {
    const paths = repairPatchPaths('*** Begin Patch\n*** Update File: src/card.ts\n*** Move to: tests/card.test.ts\n@@\n-old\n+new\n*** Add File: src/new.ts\n+export {}\n*** Delete File: src/old.ts\n*** End Patch')
    expect(paths).toEqual(['src/card.ts', 'tests/card.test.ts', 'src/new.ts', 'src/old.ts'])
    expect(canAutoRepairPaths(paths!)).toBe(false)
  })

  it.each(['not a patch', '*** Begin Patch\n*** End Patch', '*** Begin Patch\n*** Move to: src/file.ts\n*** End Patch',
    '*** Begin Patch\n*** Rename File: tests/auth.test.ts\n*** End Patch'])('rejects ambiguous or empty patch %s', (patch) => {
    expect(repairPatchPaths(patch)).toBeNull()
  })
  it.each(['.github/workflows/ci.yml', 'vitest.config.ts', 'package.json', 'supabase/migrations/applied.sql',
    'tests/e2e/login.spec.ts', 'src/auth.test.ts', 'scripts/verify.mjs', '.supremo/turn.json', '.env.local',
    '../app.ts', '/app.ts', 'src/../vitest.config.ts', 'src\\..\\package.json', 'AGENTS.md', '.claude/settings.json'])('protects %s from automatic repair', (file) => {
    expect(canAutoRepairPaths([file])).toBe(false)
    expect(beginRepair(pending(), { workspace, activeTurnId: null, requestingTurnId: null, now: NOW, changedPaths: [file] }).allowed).toBe(false)
    expect(finishRepair(repairing(), { workspace, evidence: evidence(), acceptanceCriteria: criteria, changedPaths: [file] }).status).toBe('needs_human_attention')
  })

  it.each(['node_modules/vitest/index.js', '.eslintrc.json', '.eslintignore', '.gitignore', '.npmrc', 'biome.json',
    'supabase/config.toml', '.next/server/app.js', 'coverage/coverage-final.json'])('protects dependency and gate configuration %s', (file) => {
    expect(canAutoRepairPaths([file])).toBe(false)
  })

  it('allows implementation changes subject to validation', () => {
    expect(canAutoRepairPaths(['src/actions/ticket.ts', 'src/components/card.tsx', './src/lib/auth.ts'])).toBe(true)
  })

  it.each(['http://localhost:3000', 'http://127.0.0.1:4010/tickets', 'http://[::1]:3000'])('allows low-risk browser QA on %s with test accounts', (url) => {
    expect(browserQaPolicy({ environment: 'development', url, syntheticUsers: true, action: 'fill' }).allowed).toBe(true)
  })

  it.each(['https://real.example.test', 'https://localhost.evil.test', 'https://user:password@localhost', 'file:///tmp/test.html', 'javascript:alert(1)', 'broken url'])('blocks unsafe browser target %s', (url) => {
    expect(browserQaPolicy({ environment: 'development', url, syntheticUsers: true, action: 'click' }).allowed).toBe(false)
  })

  it.each(['purchase', 'payment', 'send_email', 'delete_production', 'publish', 'cancel_order'])('blocks sensitive browser action %s', (action) => {
    expect(browserQaPolicy({ environment: 'development', url: 'http://localhost:3000', syntheticUsers: true, action }).allowed).toBe(false)
  })

  it('requires development and synthetic users', () => {
    expect(browserQaPolicy({ environment: 'production', url: 'http://localhost:3000', syntheticUsers: true, action: 'open' }).allowed).toBe(false)
    expect(browserQaPolicy({ environment: 'development', url: 'http://localhost:3000', syntheticUsers: false, action: 'open' }).allowed).toBe(false)
  })
})

describe('explicit executable state and behavior evidence', () => {
  const state: TurnState = {
    version: 1, turnId: TURN, projectId: PROJECT, environment: 'development', phase: 'preflight',
    startedAt: NOW, updatedAt: NOW, workspace, recovery: null, acceptanceCriteria: [], validations: [],
    checkpointId: null, integrationMode: 'enforced', status: 'active',
  }

  it('cannot skip preflight or continue the new feature before recovery closes', () => {
    expect(() => transitionTurn(state, 'postflight', NOW)).toThrow(/inválida/)
    expect(() => transitionTurn({ ...state, recovery: pending() }, 'work', NOW)).toThrow(/Recovery pendente/)
    const repairTurn = transitionTurn({ ...state, recovery: pending() }, 'recovery', NOW)
    expect(transitionTurn({ ...repairTurn, recovery: complete(repairing()) }, 'work', LATER).phase).toBe('work')
  })

  it('serializes the phase, integration guarantee, checkpoint, and pending evidence for a cold start', () => {
    const postflight = transitionTurn(transitionTurn(state, 'work', NOW), 'postflight', NOW)
    const coldStart = turnStateSchema.parse(JSON.parse(JSON.stringify({ ...postflight, checkpointId: CHECKPOINT, validations: [evidence({ status: 'running', completedAt: null })] })))
    expect(coldStart).toMatchObject({ phase: 'postflight', checkpointId: CHECKPOINT, integrationMode: 'enforced' })
    expect(coldStart.validations[0]?.status).toBe('running')
  })

  it('rejects a contradictory persisted state', () => {
    expect(recoveryStateSchema.safeParse(pending({ required: false })).success).toBe(false)
    expect(recoveryStateSchema.safeParse(pending({ status: 'resolved' })).success).toBe(false)
  })

  it('acceptance proof requires named checks plus a criterion association', () => {
    expect(acceptanceSatisfied(criteria, evidence())).toBe(true)
    expect(acceptanceSatisfied(criteria, evidence({ criterionIds: [] }))).toBe(false)
    expect(acceptanceSatisfied(criteria, evidence({ checks: [{ name: 'unrelated', type: 'unit', status: 'passed', evidence: 'ok' }] }))).toBe(false)
  })

  it('health is fail-closed while keeping the edit loop independent', () => {
    const input = { recovery: null, validations: [evidence()], workspace, securityState: 'safe' as const, remoteStatus: 'fresh' as const, activeTurn: false }
    expect(deriveProjectHealth(input)).toBe('healthy')
    expect(deriveProjectHealth({ ...input, securityState: 'unsafe' })).toBe('blocked')
    expect(deriveProjectHealth({ ...input, remoteStatus: 'offline', validations: [] })).toBe('validating')
    expect(deriveProjectHealth({ ...input, activeTurn: true })).toBe('developing')
    expect(deriveProjectHealth({ ...input, recovery: repairing() })).toBe('repairing')
    expect(deriveProjectHealth({ ...input, recovery: pending({ status: 'stale' }) })).toBe('needs_attention')
    expect(deriveProjectHealth({ ...input, recovery: pending() })).toBe('blocked')
    expect(deriveProjectHealth({ ...input, validations: [evidence({ status: 'failed' })] })).toBe('blocked')
  })

  it.each([
    ['RLS isolation', 'rls'], ['Typecheck', 'typecheck'], ['ESLint', 'lint'], ['Build', 'build'],
    ['Vitest coverage', 'unit'], ['Integration', 'integration'], ['Playwright', 'e2e'],
    ['Security audit', 'security'], ['Migration', 'migration'], ['Runtime exception', 'runtime'],
    ['Environment unavailable', 'environment'], ['Unrecognized job', 'unknown'],
  ] as const)('classifies %s as %s', (name, type) => { expect(classifyFailure(name)).toBe(type) })

  it('keeps setup/registry failures separate from code/security repairs', () => {
    expect(classifyFailure('RLS Docker unavailable', 'infrastructure')).toBe('external_dependency')
    expect(classifyFailure('Unrecognized check', 'code')).toBe('code')
  })
})
