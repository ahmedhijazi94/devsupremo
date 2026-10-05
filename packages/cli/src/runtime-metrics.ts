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
      const descriptor = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600)
      try {
        const stat = fs.fstatSync(descriptor)
        if (!stat.isFile() || stat.nlink !== 1) throw new Error('Invalid metrics file')
        // Keep a bounded window on the opened inode. Reopening or renaming a
        // previously checked pathname could target a concurrently replaced file.
        if (stat.size > 1024 * 1024) fs.ftruncateSync(descriptor, 0)
        fs.appendFileSync(descriptor, JSON.stringify({ version: 1, stage, durationMs: Math.round(performance.now() - started),
          outcome, at: new Date().toISOString(), ...(correlationId && /^[a-f0-9-]{36}$/.test(correlationId) ? { correlationId } : {}) }) + '\n')
      } finally { fs.closeSync(descriptor) }
    } catch { process.stderr.write('[runtime] Métrica indisponível; resultado da operação preservado.\n') }
  }
}
