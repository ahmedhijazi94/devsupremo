import { spawn } from 'node:child_process'

export class WorkerAbortedError extends Error { constructor() { super('Worker cancelado; snapshot substituído ou execução pausada.'); this.name = 'WorkerAbortedError' } }
export interface WorkerProcessOptions {
  cwd: string
  env?: NodeJS.ProcessEnv
  input?: string | undefined
  timeoutMs: number
  maxOutputBytes: number
  signal?: AbortSignal | undefined
}
/** One OS process group per job; cancellation/timeout also stops descendants.
 * Never invokes a shell; caller owns an allowlisted executable and argv. */
export function runWorkerProcess(executable: string, args: readonly string[], options: WorkerProcessOptions): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) { reject(new WorkerAbortedError()); return }
    const child = spawn(executable, [...args], { cwd: options.cwd, env: options.env,
      detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] })
    const stdoutChunks: Buffer[] = [], stderrChunks: Buffer[] = []
    let bytes = 0
    let failure: Error | null = null
    let force: ReturnType<typeof setTimeout> | undefined
    const kill = (signal: NodeJS.Signals): void => {
      if (!child.pid) return
      try { if (process.platform === 'win32') child.kill(signal); else process.kill(-child.pid, signal) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill(signal) }
    }
    const stop = (error: Error): void => {
      if (failure) return
      failure = error; kill('SIGTERM')
      force = setTimeout(() => kill('SIGKILL'), 500)
    }
    const abort = (): void => stop(new WorkerAbortedError())
    const timeout = setTimeout(() => stop(new Error('Worker excedeu o tempo permitido.')), options.timeoutMs)
    const collect = (chunk: Buffer, stream: 'stdout' | 'stderr'): void => {
      bytes += chunk.length
      if (bytes > options.maxOutputBytes) { stop(new Error('Worker excedeu o limite de saída.')); return }
      if (stream === 'stdout') stdoutChunks.push(chunk); else stderrChunks.push(chunk)
    }
    child.stdout.on('data', (chunk: Buffer) => collect(chunk, 'stdout'))
    child.stderr.on('data', (chunk: Buffer) => collect(chunk, 'stderr'))
    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted) abort()
    child.stdin.on('error', () => { /* Child may exit before consuming input; close/error carries the result. */ })
    child.stdin.end(options.input)
    child.once('error', (error) => { failure ??= error })
    child.once('close', (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString('utf8'), stderr = Buffer.concat(stderrChunks).toString('utf8')
      clearTimeout(timeout); if (force && !failure) clearTimeout(force)
      options.signal?.removeEventListener('abort', abort)
      if (failure) { reject(failure); return }
      if (code !== 0) { reject(Object.assign(new Error(`Worker terminou com código ${code ?? 'sinal'}.`), { stdout, stderr })); return }
      resolve({ stdout, stderr })
    })
  })
}
