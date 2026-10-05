import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { readJson, TURN_DIR, writeJson } from './turn-workspace'

const leaseSchema = z.object({
  version: z.literal(2), toolUseId: z.string(), sessionId: z.string(), turnId: z.string(),
  hostPid: z.number().int().positive().nullable(), hostGroupId: z.number().int().positive().nullable(),
  executionScope: z.enum(['host-file-operation', 'untracked-process']),
})
const filename = (cwd: string) => path.join(cwd, TURN_DIR, 'mutation-lease.json')

function processGroup(pid: number | null): number | null {
  if (!pid || process.platform === 'win32') return null
  try {
    const output = execFileSync('/bin/ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    const group = Number(output)
    return /^\d+$/.test(output) && Number.isSafeInteger(group) && group > 0 ? group : null
  } catch { return null /* Missing process metadata never permits lease recovery. */ }
}

/** Called under the turn lock. Generic shell commands can leave detached
 * children; their lease deliberately cannot be reclaimed by a host timeout. */
export function recordMutationLease(cwd: string, identity: { sessionId: string; turnId: string; hostPid: number | null }, toolUseId: string, toolName: string): void {
  writeJson(filename(cwd), { version: 2, ...identity, toolUseId, hostGroupId: processGroup(identity.hostPid),
    executionScope: ['Write', 'Edit', 'MultiEdit'].includes(toolName) ? 'host-file-operation' : 'untracked-process' })
}

export function processIsGone(pid: number): boolean {
  try { process.kill(pid, 0); return false }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' }
}

/** Requires the turn lock and positive death proof for the bound host and its
 * process group. Neither a clock deadline nor a reused/live PID proves death. */
export function reconcileMutationLease(cwd: string, identity: { sessionId?: string | undefined; turnId?: string | undefined; hostPid?: number | null | undefined }): boolean {
  const raw = readJson(filename(cwd))
  if (raw === null) return true
  const parsed = leaseSchema.safeParse(raw)
  if (!parsed.success) return false
  const lease = parsed.data
  if (lease.executionScope !== 'host-file-operation' || !lease.hostPid || !lease.hostGroupId ||
    lease.hostPid !== identity.hostPid || lease.sessionId !== identity.sessionId || lease.turnId !== identity.turnId ||
    !processIsGone(lease.hostPid) || !processIsGone(-lease.hostGroupId)) return false
  fs.unlinkSync(filename(cwd))
  return true
}
