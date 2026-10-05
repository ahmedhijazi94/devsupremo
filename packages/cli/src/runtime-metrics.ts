import fs from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { ensureRuntimeDirectory } from './runtime-files'

export type RuntimeStage = 'preflight' | 'checkpoint' | 'validation' | 'database' | 'model' | 'update'
/** Only bounded timings and opaque correlation IDs; never prompts, paths or output. */
export async function measureRuntime<T>(cwd: string, stage: RuntimeStage, run: () => Promise<T>, correlationId?: string): Promise<T> {
  const started = performance.now()
  let outcome: 'completed' | 'failed' = 'failed'
  try { const result = await run(); outcome = 'completed'; return result }
  finally {
    try {
      const directory = ensureRuntimeDirectory(cwd, '.supremo/runtime-metrics')
      const file = path.join(directory, 'events.jsonl')
      const stat = fs.lstatSync(file, { throwIfNoEntry: false })
      if (stat?.isSymbolicLink() || (stat && !stat.isFile())) throw new Error('Invalid metrics file')
      if (stat && stat.size > 1024 * 1024) fs.renameSync(file, path.join(directory, 'previous.jsonl'))
      fs.appendFileSync(file, JSON.stringify({ version: 1, stage, durationMs: Math.round(performance.now() - started),
        outcome, at: new Date().toISOString(), ...(correlationId && /^[a-f0-9-]{36}$/.test(correlationId) ? { correlationId } : {}) }) + '\n', { mode: 0o600 })
    } catch { process.stderr.write('[runtime] Métrica indisponível; resultado da operação preservado.\n') }
  }
}
