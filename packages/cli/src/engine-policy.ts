import path from 'node:path'
import { z } from 'zod'
import { readJson } from './turn-workspace'

export const enginePolicySchema = z.object({
  validation_mode: z.enum(['background_adaptive', 'on_request', 'background']).default('background_adaptive'),
  validation: z.object({
    debounce_ms: z.number().int().min(250).max(30_000).default(1500),
    timeout_ms: z.number().int().min(1000).max(900_000).default(180_000),
    max_output_bytes: z.number().int().min(4096).max(16 * 1024 * 1024).default(4 * 1024 * 1024),
  }).default({ debounce_ms: 1500, timeout_ms: 180_000, max_output_bytes: 4 * 1024 * 1024 }),
  auto_heal: z.object({
    enabled: z.boolean().default(true),
    paused: z.boolean().default(false),
    runner: z.enum(['codex', 'claude']).nullable().default(null),
    model: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,119}$/).optional(),
    max_attempts: z.number().int().min(1).max(5).default(2),
    timeout_ms: z.number().int().min(1000).max(600_000).default(120_000),
    max_output_bytes: z.number().int().min(4096).max(1024 * 1024).default(512 * 1024),
    max_input_bytes: z.number().int().min(4096).max(1024 * 1024).default(256 * 1024),
    max_changed_files: z.number().int().min(1).max(20).default(8),
    max_budget_usd: z.number().positive().max(100).default(2),
  }).default({ enabled: true, paused: false, runner: null, max_attempts: 2, timeout_ms: 120_000,
    max_output_bytes: 512 * 1024, max_input_bytes: 256 * 1024, max_changed_files: 8, max_budget_usd: 2 }),
})
export type EnginePolicy = z.infer<typeof enginePolicySchema>
export function readEnginePolicy(cwd: string): EnginePolicy {
  return enginePolicySchema.parse(readJson(path.join(cwd, '.supremo/lifecycle.json')) ?? {})
}
export function automaticValidation(cwd: string): boolean { return readEnginePolicy(cwd).validation_mode !== 'on_request' }
