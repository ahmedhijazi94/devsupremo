import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { readSyncedRemoteState, resolveParentCheckpointId } from './sync'
import { buildCheckpointRecord, defaultCheckpointDeps, type CheckpointRecord } from './checkpoint'

export const TURN_DIR = '.supremo/turns'

export function gitText(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): string {
  return execFileSync('git', args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 }).trim()
}

export function readJson(file: string): unknown {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as unknown }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new Error(`Estado inválido: ${path.basename(file)}`)
  }
}

export function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.${crypto.randomUUID()}.tmp`
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  fs.renameSync(temp, file)
}

/** Cross-process critical section; no live lease is silently stolen on a timeout. */
export async function withTurnLock<T>(cwd: string, work: () => T | Promise<T>): Promise<T> {
  const lock = path.join(cwd, TURN_DIR, 'lock')
  fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 })
  try { fs.mkdirSync(lock) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const owner = readJson(path.join(lock, 'owner.json')) as { pid?: number } | null
    let dead = false
    if (owner?.pid) {
      try { process.kill(owner.pid, 0) }
      catch (probe) { dead = (probe as NodeJS.ErrnoException).code === 'ESRCH' }
    }
    if (!dead) throw new Error('Lifecycle ocupado por outro processo; tente novamente.')
    fs.rmSync(lock, { recursive: true })
    fs.mkdirSync(lock)
  }
  writeJson(path.join(lock, 'owner.json'), { pid: process.pid })
  try { return await work() }
  finally { fs.rmSync(lock, { recursive: true }) }
}

/** Alternate index leaves the user's staging area and HEAD untouched. */
export function captureTree(cwd: string): { headSha: string; treeSha: string; dirty: boolean } {
  const headSha = gitText(cwd, ['rev-parse', 'HEAD'])
  const index = path.join(cwd, TURN_DIR, `index-${crypto.randomUUID()}`)
  fs.mkdirSync(path.dirname(index), { recursive: true, mode: 0o700 })
  const env = { GIT_INDEX_FILE: index }
  try {
    gitText(cwd, ['read-tree', headSha], env)
    const paths = gitText(cwd, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean)
    const runtimePath = (file: string): boolean => /^\.supremo\/(?:turns|validation|checkpoints|host-receipts)(?:\/|$)/.test(file)
      || /^\.supremo\/(?:host-adapters|bootstrap-readiness|validation-feedback|turn-context|verify-result)\.json/.test(file)
    const captured = paths.filter((file) => !runtimePath(file))
    if (captured.length) execFileSync('git', ['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], {
      cwd, env: { ...process.env, ...env, GIT_LITERAL_PATHSPECS: '1' }, input: captured.join('\0') + '\0', stdio: ['pipe', 'pipe', 'pipe'],
    })
    const excluded = paths.filter(runtimePath)
    if (excluded.length) execFileSync('git', ['update-index', '--force-remove', '-z', '--stdin'], {
      cwd, env: { ...process.env, ...env }, input: excluded.join('\0') + '\0', stdio: ['pipe', 'pipe', 'pipe'],
    })
    const treeSha = gitText(cwd, ['write-tree'], env)
    return { headSha, treeSha, dirty: treeSha !== gitText(cwd, ['rev-parse', `${headSha}^{tree}`]) }
  } finally {
    fs.rmSync(index, { force: true })
    fs.rmSync(`${index}.lock`, { force: true })
  }
}

/** Immutable, initially unvalidated checkpoint. No commit hooks or build in the edit loop. */
export function captureTurnCheckpoint(cwd: string, input: {
  projectId: string; turnId: string; summary: string; environment: 'development' | 'production' | 'unknown'
  draft?: boolean
}): CheckpointRecord | null {
  const deps = defaultCheckpointDeps(cwd)
  const queue = deps.readQueue()
  if (queue.some((record) => record.projectId !== input.projectId)) throw new Error('Fila pertence a outro projeto.')
  const snapshot = captureTree(cwd)
  const previous = queue[queue.length - 1]
  const parent = previous?.commitSha ?? snapshot.headSha
  if (gitText(cwd, ['rev-parse', `${parent}^{tree}`]) === snapshot.treeSha) return null
  // Never apply deltas from a diverged base to a later checkpoint.
  if (previous && previous.workspaceHeadSha && previous.workspaceHeadSha !== snapshot.headSha) {
    try { gitText(cwd, ['merge-base', '--is-ancestor', previous.workspaceHeadSha, snapshot.headSha]) }
    catch { throw new Error('Histórico local divergente; sincronização necessária antes do checkpoint.') }
  }
  const sha = gitText(cwd, ['commit-tree', snapshot.treeSha, '-p', parent, '-m', `checkpoint: ${input.summary}`])
  const changedPaths = gitText(cwd, ['diff', '--name-only', '-z', parent, sha]).split('\0').filter(Boolean)
  const record: CheckpointRecord = { ...buildCheckpointRecord({
    checkpointId: crypto.randomUUID(), projectId: input.projectId, commitSha: sha,
    parentCheckpointId: resolveParentCheckpointId(queue, readSyncedRemoteState(cwd)), createdAt: new Date().toISOString(),
    summary: input.summary, changedPaths,
  }), turnId: input.turnId, environment: input.environment, treeSha: snapshot.treeSha,
    workspaceHeadSha: snapshot.headSha, validationStatus: 'pending', ...(input.draft ? { draft: true } : {}) }
  // Keep detached snapshots reachable through Git GC, before durable queue append.
  gitText(cwd, ['update-ref', `refs/supremo/checkpoints/${record.checkpointId}`, sha])
  if (!input.draft) {
    deps.appendQueue(record)
    deps.notifyDaemon()
  }
  return record
}
