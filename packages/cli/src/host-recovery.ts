import path from 'node:path'
import { z } from 'zod'
import { readJson, TURN_DIR, withTurnLock, writeJson } from './turn-workspace'

/** Recover only proved-dead hosts with no possibly active tool. A stale clock,
 * missing PID, EPERM or a mutation lease never authorizes taking their workspace. */
export async function reconcileAbandonedHost(cwd: string): Promise<boolean> {
  return withTurnLock(cwd, () => {
    const filename = path.join(cwd, TURN_DIR, 'state.json')
    const raw = readJson(filename)
    const state = z.object({ hostPid: z.number().int().positive().nullable().optional(),
      turn: z.object({ status: z.string() }).passthrough() }).passthrough().safeParse(raw)
    if (!state.success || state.data.turn.status !== 'active' || !state.data.hostPid ||
      readJson(path.join(cwd, TURN_DIR, 'mutation-lease.json')) !== null) return false
    try { process.kill(state.data.hostPid, 0); return false }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return false }
    writeJson(filename, { ...state.data, turn: { ...state.data.turn, status: 'blocked', updatedAt: new Date().toISOString() } })
    writeJson(path.join(cwd, TURN_DIR, 'interruption.json'), { version: 1, observedAt: new Date().toISOString(),
      reason: 'host_process_exited', nextAction: 'O host foi interrompido. O worker pode retomar snapshots existentes; novo preflight reconcilia edições ainda não capturadas.' })
    return true
  })
}
