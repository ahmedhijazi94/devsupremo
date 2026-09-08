import fs from 'node:fs'
import path from 'node:path'
import { buildCheckpointRecord, nextParentId } from './checkpoint'
import type { RestoreDeps } from './restore'

export interface RestoreReceipt {
  projectId: string
  requestId: string
  claimToken: string
  targetCheckpointId: string
  resultCheckpointId: string
  status: 'applying' | 'applied' | 'failed'
  resultCommitSha: string | null
  error: string | null
  acknowledged: boolean
}
const directory = '.supremo/checkpoints/restore-outbox'

/** A durable intent is written before mutation, and retained after server ACK. */
export function writeRestoreReceipt(cwd: string, receipt: RestoreReceipt): void {
  const folder = path.join(cwd, directory)
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 })
  const destination = path.join(folder, `${encodeURIComponent(receipt.requestId)}.json`)
  const temporary = `${destination}.${process.pid}.tmp`
  const descriptor = fs.openSync(temporary, 'w', 0o600)
  try { fs.writeFileSync(descriptor, JSON.stringify(receipt)); fs.fsyncSync(descriptor) }
  finally { fs.closeSync(descriptor) }
  fs.renameSync(temporary, destination)
}

export function readRestoreReceipts(cwd: string, projectId: string): RestoreReceipt[] {
  const folder = path.join(cwd, directory)
  if (!fs.existsSync(folder)) return []
  return fs.readdirSync(folder).filter((name) => name.endsWith('.json')).map((name) => {
    // Corruption must stop restoration, never silently drop an idempotency key.
    const value: unknown = JSON.parse(fs.readFileSync(path.join(folder, name), 'utf8'))
    if (!value || typeof value !== 'object') throw new Error('Registro de restauração inválido.')
    const r = value as RestoreReceipt
    if (typeof r.projectId !== 'string' || typeof r.requestId !== 'string' || typeof r.claimToken !== 'string'
      || typeof r.targetCheckpointId !== 'string' || typeof r.resultCheckpointId !== 'string'
      || !['applying','applied','failed'].includes(r.status) || typeof r.acknowledged !== 'boolean') {
      throw new Error('Registro de restauração inválido.')
    }
    return r
  }).filter((r) => r.projectId === projectId)
}

/** Recover a commit made before a crash between git commit and queue append. */
export function recoverRestoreReceipt(receipt: RestoreReceipt, deps: RestoreDeps): RestoreReceipt {
  if (receipt.status !== 'applying') return receipt
  const queue = deps.readQueue()
  const existing = queue.find((r) => r.checkpointId === receipt.resultCheckpointId && r.projectId === receipt.projectId
    && r.restoredFromCheckpointId === receipt.targetCheckpointId)
  if (existing) return { ...receipt, status: 'applied', resultCommitSha: existing.commitSha }
  // UUID-only interpolation into a git argument (never a shell command).
  if (/^[a-f0-9-]{36}$/.test(receipt.requestId)) {
    const sha = deps.git(['log', '-1', '--format=%H', '--fixed-strings', '--grep', `Supremo-Restore-Request: ${receipt.requestId}`]).trim()
    if (/^[a-f0-9]{40}$/.test(sha) && deps.git(['rev-parse', 'HEAD']).trim() === sha) {
      const paths = deps.git(['diff-tree', '--no-commit-id', '--name-only', '-r', sha]).trim().split('\n').filter(Boolean)
      const record = buildCheckpointRecord({ checkpointId: receipt.resultCheckpointId, projectId: receipt.projectId,
        commitSha: sha, parentCheckpointId: nextParentId(queue), createdAt: deps.now(),
        summary: 'Restauração recuperada após reinício', changedPaths: paths,
        restoredFromCheckpointId: receipt.targetCheckpointId })
      // Authority is refreshed by the runtime before this recovered record is uploaded.
      deps.appendQueue(record)
      return { ...receipt, status: 'applied', resultCommitSha: sha }
    }
  }
  return { ...receipt, status: 'failed', error: 'Restauração interrompida antes da confirmação. Trabalho preservado; solicite novamente.' }
}
