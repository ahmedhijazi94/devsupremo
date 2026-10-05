import path from 'node:path'
import { z } from 'zod'
import { readEnginePolicy } from './engine-policy'
import { resolveRepairExecutable } from './repair-executable'
import { inspectRuntimeVersions } from './runtime-version'
import { validationWorkerHealthy, requestCheckpointValidation } from './turn-validation'
import { defaultCheckpointDeps, type CheckpointRecord } from './checkpoint'
import { readJson, writeJson } from './turn-workspace'
import type { FailureType } from './turn-model'
import { hostIntegrationMode } from './host-adapters'

/** Only hand off an obligation when both validation and an authorized repair
 * executor are actually available. Missing evidence preserves the foreground gate. */
export function backgroundRecoveryAvailable(cwd: string, host?: string): boolean {
  const policy = readEnginePolicy(cwd).auto_heal
  if (!policy.enabled || policy.paused || !validationWorkerHealthy(cwd) || !inspectRuntimeVersions(cwd).compatible) return false
  const state = z.object({ host: z.string(), sessionId: z.string() }).safeParse(readJson(path.join(cwd, '.supremo/turns/state.json')))
  const inferredHost = state.success && (!host || host === state.data.host)
    && hostIntegrationMode(cwd, state.data.host, state.data.sessionId) !== 'unsupported' ? state.data.host : null
  const runner = policy.runner ?? (inferredHost === 'codex' ? 'codex' : inferredHost === 'claude-code' ? 'claude' : null)
  if (!runner) return false
  try { resolveRepairExecutable(runner); return true }
  catch { return false }
}
const recoverySchema = z.object({ version: z.literal(1), checkpointId: z.string().uuid(), projectId: z.string().uuid(),
  failureId: z.string(), fingerprint: z.string(), requiredTypes: z.array(z.enum(['typecheck', 'lint', 'unit', 'integration'])),
  status: z.literal('pending'), requestedAt: z.number(), responsible: z.literal('validation-and-repair-worker') })
export function scheduleBackgroundRecovery(cwd: string, record: CheckpointRecord, failureId: string, requiredTypes: readonly FailureType[]): void {
  const request = recoverySchema.parse({ version: 1, checkpointId: record.checkpointId, projectId: record.projectId,
    failureId, fingerprint: record.treeSha, requiredTypes, status: 'pending', requestedAt: Date.now(), responsible: 'validation-and-repair-worker' })
  // Persist ownership before allowing the interactive turn to end. Full checks
  // prevent a cosmetic diff from hiding a previously failing coverage gate.
  writeJson(path.join(cwd, '.supremo/validation/recovery', `${record.checkpointId}.json`), request)
  requestCheckpointValidation(cwd, { ...record, recoveryValidation: true })
}
export function backgroundRecoveryStatus(cwd: string, checkpointId: string): Record<string, unknown> | null {
  const raw = readJson(path.join(cwd, '.supremo/validation/recovery', `${z.string().uuid().parse(checkpointId)}.json`))
  if (raw === null) return null
  const request = recoverySchema.parse(raw)
  const record = defaultCheckpointDeps(cwd).readQueue().find(item => item.checkpointId === checkpointId)
  return { ...request, status: record?.validationStatus ?? 'pending', approved: false,
    nextAction: 'Consulte turn status. Provas atuais continuam obrigatórias; publicação e CI são independentes.' }
}
