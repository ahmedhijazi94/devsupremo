import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
export type ProcessState = 'alive' | 'dead' | 'unknown'

export function processState(pid: number): ProcessState {
  try { process.kill(pid, 0); return 'alive' } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'dead' : 'unknown'
  }
}

interface LockOwner { pid: number; token: string }
function lockOwner(lock: string): LockOwner | null {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8')) as Partial<LockOwner>
    return Number.isSafeInteger(value.pid) && (value.pid ?? 0) > 0 && typeof value.token === 'string'
      ? value as LockOwner : null
  } catch { return null }
}

/** A crashed reclaimer is claimed in-place, never unlinked under a new owner. */
function claimAbandoned(lock: string, previous: LockOwner, owner: LockOwner, stagingRoot: string, depth = 0): boolean {
  if (depth > 8) return false
  const claim = path.join(lock, 'reclaim')
  const staging = path.join(stagingRoot, `daemon-claim-${randomUUID()}.tmp`)
  fs.mkdirSync(staging)
  try {
    fs.writeFileSync(path.join(staging, 'owner.json'), JSON.stringify(owner), { mode: 0o600 })
    let claimed = false
    try { fs.renameSync(staging, claim); claimed = true } catch (error) {
      // macOS can report EINVAL (Linux ENOENT/ENOTDIR) when another
      // reclaimer removes the destination's parent during this rename.
      if (!['EEXIST', 'ENOTEMPTY', 'ENOENT', 'ENOTDIR', 'EINVAL'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
      const abandoned = lockOwner(claim)
      if (abandoned && processState(abandoned.pid) === 'dead') claimed = claimAbandoned(claim, abandoned, owner, stagingRoot, depth + 1)
    }
    const current = lockOwner(lock)
    return claimed && current?.token === previous.token && processState(current.pid) === 'dead'
  } finally { fs.rmSync(staging, { recursive: true, force: true }) }
}

function retireLock(lock: string): void {
  const retired = `${lock}.${randomUUID()}.retired`
  // Never recursively remove the public path: after ownership disappears a
  // new contender may publish its own lease there. Detach our directory first.
  fs.renameSync(lock, retired)
  fs.rmSync(retired, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 })
}

/** Serializes starts/stops across CLI invocations, including a crashed lock owner. */
export async function withDaemonControl<T>(cwd: string, run: () => Promise<T>): Promise<T> {
  const directory = path.join(cwd, '.supremo/checkpoints')
  const lock = path.join(directory, 'daemon-control.lock')
  const owner = { pid: process.pid, token: randomUUID() }
  fs.mkdirSync(directory, { recursive: true })
  // Publish ownership and directory atomically. Crashing before rename leaves
  // only an unused unique staging directory, never an ownerless active lock.
  const staging = path.join(directory, `daemon-control-${owner.token}.tmp`)
  fs.mkdirSync(staging)
  fs.writeFileSync(path.join(staging, 'owner.json'), JSON.stringify(owner), { mode: 0o600 })
  const deadline = Date.now() + 7000
  try {
    for (;;) {
      try { fs.renameSync(staging, lock); break } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
        const previous = lockOwner(lock)
        if (previous && processState(previous.pid) === 'dead') {
          if (claimAbandoned(lock, previous, owner, directory)) {
            retireLock(lock)
            continue
          }
        }
        if (Date.now() >= deadline) throw new Error('Controle do daemon ocupado; nenhuma instância adicional foi iniciada.')
        await pause(40)
      }
    }
    return await run()
  } finally {
    if (lockOwner(lock)?.token === owner.token) retireLock(lock)
    fs.rmSync(staging, { recursive: true, force: true })
  }
}

export interface ManagedDaemonIdentity { command: string; started: string; startedAt: number; cwd: string }

/** OS evidence is required before signaling; a pidfile alone cannot authorize a kill. */
export async function inspectManagedDaemon(cwd: string, pid: number, bins: string[]): Promise<ManagedDaemonIdentity | null> {
  if (pid === process.pid || !Number.isSafeInteger(pid) || pid <= 0) return null
  if (process.platform !== 'darwin' && process.platform !== 'linux') return null
  try {
    const options = { encoding: 'utf8' as const, timeout: 1000, maxBuffer: 16384, env: { ...process.env, LC_ALL: 'C' } }
    const [commandResult, startedResult, executableResult, directory] = await Promise.all([
      execute('/bin/ps', ['-ww', '-p', String(pid), '-o', 'args='], options),
      execute('/bin/ps', ['-p', String(pid), '-o', 'lstart='], options),
      execute('/bin/ps', ['-p', String(pid), '-o', 'comm='], options),
      process.platform === 'linux' ? Promise.resolve(fs.readlinkSync(`/proc/${pid}/cwd`))
        : execute('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], options)
          .then(result => result.stdout.split('\n').find(line => line.startsWith('n'))?.slice(1) ?? ''),
    ])
    const command = commandResult.stdout.trim()
    const started = startedResult.stdout.trim()
    const executable = executableResult.stdout.trim()
    if (!['node', 'nodejs'].includes(path.basename(executable))) return null
    const startedAt = Date.parse(started)
    const realCwd = fs.realpathSync(cwd)
    if (!Number.isFinite(startedAt) || fs.realpathSync(directory) !== realCwd) return null
    const candidates = bins.flatMap(bin => {
      if (!path.isAbsolute(bin)) return []
      try { return [bin, fs.realpathSync(bin)] } catch { return [bin] }
    })
    const executables = [executable, process.execPath, fs.realpathSync(process.execPath)]
    if (!candidates.some(bin => executables.some(node => command === `${node} ${bin} daemon`))) return null
    return { command, started, startedAt, cwd: realCwd }
  } catch {
    // Missing inspection permissions/tools are uncertainty, never permission to kill.
    return null
  }
}

export interface StopDaemonDependencies {
  inspect: () => Promise<ManagedDaemonIdentity | null>
  current: () => boolean
  state: () => ProcessState
  signal: (signal: 'SIGTERM' | 'SIGKILL') => void
  pause: (ms: number) => Promise<void>
}

/** Bounded TERM/KILL; callers can start a replacement only after ESRCH. */
export async function stopManagedDaemon(identity: ManagedDaemonIdentity, deps: StopDaemonDependencies): Promise<boolean> {
  const matches = async (): Promise<boolean> => {
    if (!deps.current()) return false
    const current = await deps.inspect()
    return deps.current() && current?.command === identity.command && current.started === identity.started && current.cwd === identity.cwd
  }
  for (const [signal, attempts] of [['SIGTERM', 30], ['SIGKILL', 20]] as const) {
    if (deps.state() === 'dead') return true
    if (deps.state() !== 'alive' || !await matches()) return false
    try { deps.signal(signal) } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH'
    }
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (deps.state() === 'dead') return true
      if (deps.state() === 'unknown' || !deps.current()) return false
      await deps.pause(50)
    }
  }
  return deps.state() === 'dead'
}

export async function terminateManagedDaemon(cwd: string, pid: number, bins: string[], current: () => boolean,
  updatedAt?: number): Promise<boolean> {
  const inspect = (): Promise<ManagedDaemonIdentity | null> => inspectManagedDaemon(cwd, pid, bins)
  const identity = await inspect()
  // A receipt from a previous process using this PID cannot justify recovery.
  if (!identity || (updatedAt !== undefined && updatedAt < identity.startedAt)) return false
  return stopManagedDaemon(identity, { inspect, current, state: () => processState(pid), signal: signal => { process.kill(pid, signal) }, pause })
}
