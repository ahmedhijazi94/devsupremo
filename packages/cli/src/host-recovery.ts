import path from 'node:path'
import { z } from 'zod'
import { readJson, TURN_DIR, withTurnLock, writeJson } from './turn-workspace'
import { processIsGone, reconcileMutationLease } from './mutation-lease'

/** Recover only proved-dead hosts with no possibly active tool. A stale clock,
 * missing PID or EPERM never authorizes taking their workspace. File-tool leases
 * can be recovered only with matching identity and proof the process group died. */
export async function reconcileAbandonedHost(cwd: string): Promise<boolean> {
  return withTurnLock(cwd, () => {
    const filename = path.join(cwd, TURN_DIR, 'state.json')
    const raw = readJson(filename)
    const state = z.object({ hostPid: z.number().int().positive().nullable().optional(), sessionId: z.string().optional(),
      turn: z.object({ status: z.string(), turnId: z.string().optional() }).passthrough() }).passthrough().safeParse(raw)
    if (!state.success || state.data.turn.status !== 'active' || !state.data.hostPid || !processIsGone(state.data.hostPid)) return false
    if (!reconcileMutationLease(cwd, { ...state.data, turnId: state.data.turn.turnId })) return false
    writeJson(filename, { ...state.data, turn: { ...state.data.turn, status: 'blocked', updatedAt: new Date().toISOString() } })
    writeJson(path.join(cwd, TURN_DIR, 'interruption.json'), { version: 1, observedAt: new Date().toISOString(),
      reason: 'host_process_exited', nextAction: 'O host foi interrompido. O worker pode retomar snapshots existentes; novo preflight reconcilia edições ainda não capturadas.' })
    return true
  })
}
