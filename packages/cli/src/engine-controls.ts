import path from 'node:path'
import { z } from 'zod'
import { enginePolicySchema, readEnginePolicy } from './engine-policy'
import { readJson, withTurnLock, writeJson } from './turn-workspace'

const actionSchema = z.enum(['status', 'pause', 'resume', 'automatic', 'on-request'])
/** Local controls never grant remote permissions or change deployment gates. */
export async function controlEngine(cwd: string, action: string): Promise<Record<string, unknown>> {
  const selected = actionSchema.parse(action)
  z.object({ projectId: z.string().uuid() }).parse(readJson(path.join(cwd, '.supremo/project.json')))
  if (selected !== 'status') await withTurnLock(cwd, () => {
    const policy = readEnginePolicy(cwd)
    const original = readJson(path.join(cwd, '.supremo/lifecycle.json'))
    const retained = original && typeof original === 'object' && !Array.isArray(original) ? original : {}
    if (selected === 'pause' || selected === 'resume') policy.auto_heal.paused = selected === 'pause'
    else policy.validation_mode = selected === 'automatic' ? 'background_adaptive' : 'on_request'
    writeJson(path.join(cwd, '.supremo/lifecycle.json'), { ...retained, ...enginePolicySchema.parse(policy) })
  })
  const policy = readEnginePolicy(cwd)
  return { policy, autoHeal: readJson(path.join(cwd, '.supremo/validation/repair/status.json')),
    budget: { attempts: policy.auto_heal.max_attempts, timeoutMs: policy.auto_heal.timeout_ms,
      monetaryCapUsd: policy.auto_heal.runner === 'claude' ? policy.auto_heal.max_budget_usd : null },
    deployment: 'Complete GitHub gates and independent engine policy remain mandatory.' }
}
