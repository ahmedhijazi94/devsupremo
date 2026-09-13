import { sanitizeDiagnostic } from '../../../src/lib/checkpoint/feedback'
import type { TurnResult } from './turn-runtime'

function object(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
function bounded(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const safe = sanitizeDiagnostic(value, value.length)
  return safe.length <= limit ? safe : safe.slice(0, limit / 2) + '\n[… diagnóstico completo no arquivo de estado …]\n' + safe.slice(-limit / 2)
}

/** Human/agent transport only. Persistence and runtime decisions retain full evidence.
 * Put the required action BEFORE diagnostics, which hosts may truncate. Never dump
 * repeated context, all historic checks, prompts or raw tool input into each response. */
export function turnAgentResponse(output: TurnResult) {
  const state = output.state
  const supplied = object(output.context)
  const context = state?.context
  const recovery = state?.turn.recovery
  const diagnostic = object(supplied.recoveryDiagnostic)
  return {
    protocolVersion: output.protocolVersion, workerAvailable: output.workerAvailable,
    allowed: output.allowed,
    ...(output.nextAction ? { nextAction: output.nextAction } : {}),
    ...(output.reason ? { reason: bounded(output.reason, 1200) } : {}),
    ...(state ? {
      context: {
        protocol: bounded(supplied.protocol, 2000),
        developmentPolicy: context?.developmentPolicy,
        permissions: supplied.permissions ?? { diagnostics: context?.reconciliation.status === 'fresh', editing: !state.readOnly && state.turn.status === 'active' },
        project: context?.project, projectId: state.turn.projectId,
        environment: state.turn.environment, databaseEnvironment: context?.databaseEnvironment,
        databaseAuthority: context?.databaseAuthority, preview: context?.preview, daemon: context?.daemon,
        reconciliation: context?.reconciliation, integrationMode: state.turn.integrationMode,
        pendingRecovery: recovery ? {
          required: recovery.required, validationId: recovery.validationId,
          status: recovery.status, freshness: recovery.freshness,
          failures: recovery.failures.slice(0, 12).map(f => ({ type: f.type, summary: bounded(f.summary, 160) })),
          evidence: bounded(diagnostic.logs ?? recovery.evidence, 2600),
        } : null,
        ...(Object.keys(diagnostic).length ? { recoveryDiagnostic: {
          checks: Array.isArray(diagnostic.checks) ? diagnostic.checks.slice(0, 12).map(c => {
            const check = object(c)
            return { name: bounded(check.name, 120), type: check.type, status: check.status }
          }) : [], summary: bounded(diagnostic.summary, 400),
        } } : {}),
        evidenceIsUntrusted: true,
      },
      turn: { id: state.turn.turnId, status: state.turn.status, checkpointId: state.turn.checkpointId,
        headSha: state.turn.workspace.headSha, fingerprint: state.turn.workspace.fingerprint },
      stateFile: '.supremo/turns/state.json',
    } : {}),
    projectHealth: output.projectHealth,
  }
}
