import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultCheckpointDeps, QUEUE_FILE, type CheckpointRecord } from './checkpoint'
import { drainOnce, type DaemonHttp } from './daemon'
import { evidenceFor, requestCheckpointValidation, type LocalEvidence } from './turn-validation'
import { gitText, writeJson } from './turn-workspace'

const PROJECT = '11111111-1111-4111-8111-111111111111'
let cwd: string
let baseSha: string
let count: number
const publish = vi.fn<DaemonHttp['publish']>()
const http: DaemonHttp = {
  publish, pollRestores: async () => [], reportRestoreApplied: async () => undefined,
  reportRestoreFailed: async () => undefined, syncStatus: async () => ({ latest: null }),
}

function checkpoint(): CheckpointRecord {
  fs.writeFileSync(path.join(cwd, 'page.ts'), `export const value = ${++count}\n`)
  gitText(cwd, ['add', 'page.ts']); gitText(cwd, ['commit', '-m', `Fixture ${count}`])
  const commitSha = gitText(cwd, ['rev-parse', 'HEAD'])
  return { projectId: PROJECT, checkpointId: crypto.randomUUID(), commitSha,
    treeSha: gitText(cwd, ['rev-parse', `${commitSha}^{tree}`]), changesetBaseSha: baseSha,
    parentCheckpointId: null, createdAt: new Date().toISOString(), summary: 'Fixture',
    riskLevel: 'low', migrations: [], changedPaths: ['page.ts'], pushStatus: 'local', attempts: 0,
    environment: 'development', validationStatus: 'deferred', validationId: crypto.randomUUID(), validatedSha: commitSha }
}

function proof(record: CheckpointRecord, patch: Partial<LocalEvidence> = {}): LocalEvidence {
  const now = new Date().toISOString()
  return { id: record.validationId!, projectId: record.projectId, checkpointId: record.checkpointId,
    sha: record.commitSha, baseSha: record.changesetBaseSha!, fingerprint: record.treeSha!,
    environment: 'development', status: 'deferred', startedAt: now, finishedAt: now,
    summary: 'Snapshot checked; CI remains required', logs: '', checks: [], criterionIds: [], acceptanceCriteria: [], ...patch }
}
function saveProof(record: CheckpointRecord, patch: Partial<LocalEvidence> = {}): void {
  writeJson(path.join(cwd, '.supremo/validation', `${record.validationId}.json`), proof(record, patch))
}
function queue(): CheckpointRecord[] { return defaultCheckpointDeps(cwd).readQueue() }
function append(record: CheckpointRecord): void { defaultCheckpointDeps(cwd).appendQueue(record) }
function drain(): Promise<number> {
  return drainOnce({ cwd, projectId: PROJECT, apiBaseUrl: 'https://supremo.example', getSecret: () => 'device-fixture' }, { http })
}

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'supremo-evidence-recovery-'))
  gitText(cwd, ['init', '-b', 'main']); gitText(cwd, ['config', 'user.name', 'Fixture'])
  gitText(cwd, ['config', 'user.email', 'fixture@example.invalid'])
  fs.writeFileSync(path.join(cwd, '.gitignore'), '.supremo/\n')
  fs.writeFileSync(path.join(cwd, 'page.ts'), 'export const value = 0\n')
  gitText(cwd, ['add', '-A']); gitText(cwd, ['commit', '-m', 'Baseline'])
  baseSha = gitText(cwd, ['rev-parse', 'HEAD']); count = 0
  publish.mockReset().mockResolvedValue({ prNumber: 12 })
})
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(cwd, { recursive: true, force: true }) })

describe('recovery of completed checkpoints without trustworthy evidence', () => {
  it.each(['absent-id', 'absent-file', 'corrupt-json', 'wrong-sha', 'wrong-base', 'wrong-tree', 'wrong-project', 'wrong-environment', 'absent-validated-sha', 'wrong-validated-sha'] as const)(
    'reschedules %s once and waits without queue churn or upload', async scenario => {
      const record = checkpoint()
      if (scenario === 'absent-id') delete record.validationId
      else if (scenario !== 'absent-file') {
        const patch: Partial<LocalEvidence> = scenario === 'wrong-sha' ? { sha: 'a'.repeat(40) }
          : scenario === 'wrong-base' ? { baseSha: 'a'.repeat(40) }
            : scenario === 'wrong-tree' ? { fingerprint: 'a'.repeat(40) }
              : scenario === 'wrong-project' ? { projectId: crypto.randomUUID() }
                : scenario === 'wrong-environment' ? { environment: 'production' } : {}
        saveProof(record, patch)
        if (scenario === 'corrupt-json') fs.writeFileSync(path.join(cwd, '.supremo/validation', `${record.validationId}.json`), '{')
      }
      if (scenario === 'absent-validated-sha') delete record.validatedSha
      if (scenario === 'wrong-validated-sha') record.validatedSha = 'a'.repeat(40)
      append(record)
      expect(await drain()).toBe(0)
      expect(queue()[0]).toMatchObject({ validationStatus: 'pending', commitSha: record.commitSha })
      expect(queue()[0]?.validationId).toBeUndefined()
      expect(queue()[0]?.validatedSha).toBeUndefined()
      const scheduled = fs.readFileSync(path.join(cwd, QUEUE_FILE), 'utf8')
      expect(await drain()).toBe(0)
      expect(fs.readFileSync(path.join(cwd, QUEUE_FILE), 'utf8')).toBe(scheduled)
      expect(publish).not.toHaveBeenCalled()

      // A worker's renewed proof is required before transport may continue.
      const completed = { ...record, validationId: crypto.randomUUID(), validatedSha: record.commitSha }
      saveProof(completed); append(completed)
      expect(await drain()).toBe(1)
      expect(publish).toHaveBeenCalledTimes(1)
      expect(queue()[0]).toMatchObject({ pushStatus: 'published', validationStatus: 'deferred' })
    })

  it.each(['pending', 'running'] as const)('does not publish %s using an earlier otherwise valid proof', async validationStatus => {
    const record = { ...checkpoint(), validationStatus }
    saveProof(record); append(record)
    const original = fs.readFileSync(path.join(cwd, QUEUE_FILE), 'utf8')
    expect(await drain()).toBe(0)
    expect(publish).not.toHaveBeenCalled()
    expect(fs.readFileSync(path.join(cwd, QUEUE_FILE), 'utf8')).toBe(original)
  })

  it.each([false, true])('preserves a real failed proof even with mismatched queue SHA: %s', async mismatchedSha => {
    const record = checkpoint()
    saveProof(record, { status: 'failed', failureReason: 'security', checks: [{ name: 'secret scan', type: 'security', status: 'failed' }] })
    if (mismatchedSha) record.validatedSha = 'a'.repeat(40)
    append(record)
    expect(await drain()).toBe(0)
    expect(queue()[0]).toMatchObject({ validationStatus: 'failed', validationId: record.validationId })
    expect(fs.existsSync(path.join(cwd, '.supremo/checkpoints/evidence-recovery'))).toBe(false)
    expect(publish).not.toHaveBeenCalled()
  })

  it('bounds repeated evidence loss, reports integrity explicitly and permits requested revalidation', async () => {
    const record = checkpoint(); append(record)
    await drain()
    // Simulate a completed recovery that still fails to persist its proof.
    append(record); await drain()
    const failed = queue()[0]!
    expect(failed.validationStatus).toBe('failed')
    expect(evidenceFor(cwd, failed)).toMatchObject({ status: 'failed', failureReason: 'invalid_evidence',
      summary: expect.stringContaining('Integridade da evidência'), logs: expect.stringContaining('Isso não indica erro no código') })
    const stopped = fs.readFileSync(path.join(cwd, QUEUE_FILE), 'utf8')
    await drain()
    expect(fs.readFileSync(path.join(cwd, QUEUE_FILE), 'utf8')).toBe(stopped)
    expect(publish).not.toHaveBeenCalled()

    requestCheckpointValidation(cwd, failed)
    expect(queue()[0]?.validationStatus).toBe('pending')
    const completed = { ...record, validationId: crypto.randomUUID() }
    saveProof(completed); append(completed)
    expect(await drain()).toBe(1)
    expect(queue()[0]?.pushStatus).toBe('published')
  })

  it('gives a different diff base its own recovery while preserving the original bound', async () => {
    const record = checkpoint(); append(record); await drain()
    const revised = { ...record, changesetBaseSha: record.commitSha }
    append(revised); await drain()
    expect(queue()[0]).toMatchObject({ validationStatus: 'pending', changesetBaseSha: revised.changesetBaseSha })
    expect(fs.readdirSync(path.join(cwd, '.supremo/checkpoints/evidence-recovery'))).toHaveLength(2)
    append(revised); await drain()
    expect(queue()[0]?.validationStatus).toBe('failed')
    expect(publish).not.toHaveBeenCalled()
  })

  it('does not starve a later checkpoint validated over the full unpublished diff', async () => {
    const first = checkpoint(); append(first); await drain(); append(first)
    const later = checkpoint(); saveProof(later); append(later)
    expect(await drain()).toBe(1)
    expect(queue()[0]?.validationStatus).toBe('failed')
    expect(queue()[1]).toMatchObject({ checkpointId: later.checkpointId, pushStatus: 'published', changesetBaseSha: baseSha })
    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish.mock.calls[0]?.[0].changeset.checkpointId).toBe(later.checkpointId)
  })
})
