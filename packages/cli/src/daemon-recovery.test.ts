import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseQueue, QUEUE_FILE, serializeQueue, type CheckpointRecord } from './checkpoint'
import * as changesetModule from './changeset'
import type { CommitReader } from './changeset'
import { defaultDaemonHttp, drainOnce, NetworkError, processCheckpoint, type DaemonHttp, type PublishInput } from './daemon'
import * as validationModule from './turn-validation'
import type { LocalEvidence } from './turn-validation'

const reader: CommitReader = {
  changes: () => [{ status: 'M', path: 'src/app/page.tsx' }],
  content: () => Buffer.from('export default function Page() { return null }\n'),
  meta: () => ({ message: 'Checkpoint de teste', authorName: 'Teste', authorEmail: 'teste@example.invalid' }),
  executable: () => false,
}

function checkpoint(): CheckpointRecord {
  return {
    projectId: '11111111-1111-4111-8111-111111111111',
    checkpointId: '22222222-2222-4222-8222-222222222222',
    commitSha: 'a'.repeat(40), treeSha: 'b'.repeat(40), changesetBaseSha: 'c'.repeat(40),
    parentCheckpointId: null, createdAt: '2026-09-13T18:42:00.000Z',
    summary: 'Paleta azul', riskLevel: 'low', migrations: [], changedPaths: ['src/app/page.tsx'],
    pushStatus: 'local', attempts: 0, environment: 'development',
    validationStatus: 'deferred', validatedSha: 'a'.repeat(40),
    validationId: '33333333-3333-4333-8333-333333333333',
  }
}

function evidence(record: CheckpointRecord): LocalEvidence {
  return {
    id: record.validationId!, projectId: record.projectId, checkpointId: record.checkpointId,
    sha: record.commitSha, fingerprint: record.treeSha!, baseSha: record.changesetBaseSha!,
    environment: 'development', status: 'deferred', startedAt: '2026-09-13T18:42:00.000Z',
    finishedAt: '2026-09-13T18:43:00.000Z', summary: 'Transporte validado', logs: '',
    criterionIds: [], acceptanceCriteria: [], checks: [],
  }
}

function fakeHttp(publish: DaemonHttp['publish']): DaemonHttp {
  return {
    publish, pollRestores: async () => [], reportRestoreApplied: async () => undefined,
    reportRestoreFailed: async () => undefined, syncStatus: async () => ({ latest: null }),
  }
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('recuperação automática da publicação', () => {
  it.each(['headers', 'body'] as const)('aborta resposta parada em %s e reenvia o mesmo checkpoint sem sobrepor conexões', async (stall) => {
    const requests: PublishInput[] = []
    let active = 0
    let maximumActive = 0
    let firstClosed = false
    const server = http.createServer((req, res) => {
      active += 1
      maximumActive = Math.max(maximumActive, active)
      const first = requests.length === 0
      res.once('close', () => { active -= 1; if (first) firstClosed = true })
      let body = ''
      req.setEncoding('utf8')
      req.on('data', (chunk: string) => { body += chunk })
      req.on('end', () => {
        requests.push(JSON.parse(body) as PublishInput)
        if (first) {
          if (stall === 'body') {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.write('{"prNumber":')
          }
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ prNumber: 17, published: true, idempotent: true }))
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Porta HTTP indisponível')
    try {
      const record = checkpoint()
      const client = defaultDaemonHttp(`http://127.0.0.1:${address.port}`, { publishTimeoutMs: 100 })
      const context = { projectId: record.projectId, getSecret: () => 'device-example', http: client, reader }
      const startedAt = Date.now()
      const interrupted = await processCheckpoint(record, context)
      expect(interrupted).toMatchObject({ result: 'deferred', reason: 'timeout',
        record: { pushStatus: 'upload_pending', attempts: 1 } })
      expect(Date.now() - startedAt).toBeLessThan(2000)
      await vi.waitFor(() => expect(firstClosed).toBe(true), { timeout: 1000, interval: 10 })

      const recovered = await processCheckpoint(interrupted.record, context)
      expect(recovered).toMatchObject({ result: 'done', record: { pushStatus: 'published', prNumber: 17 } })
      expect(requests).toHaveLength(2)
      expect(requests[1]).toEqual(requests[0])
      expect(requests[1]?.changeset.checkpointId).toBe(record.checkpointId)
      expect(requests[1]?.changeset.commitSha).toBe(record.commitSha)
      expect(requests[1]?.changesetSha256).toMatch(/^[a-f0-9]{64}$/)
      expect(maximumActive).toBe(1)
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it.each([undefined, null, 0, -1, 1.5, '17'])('não declara publicação sem uma PR válida: %s', async (prNumber) => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ prNumber, published: true })))
    const record = checkpoint()
    const outcome = await processCheckpoint(record, {
      projectId: record.projectId, getSecret: () => 'device-example', reader,
      http: defaultDaemonHttp('https://supremo.example'),
    })
    expect(outcome).toMatchObject({ result: 'deferred', record: { pushStatus: 'upload_pending', attempts: 1 } })
    expect(outcome.record.prNumber).toBeUndefined()
  })

  it.each(['success', 'timeout'] as const)('preserva diagnóstico mais novo quando o envio termina com %s', async (result) => {
    const cwd = mkdtempSync(join(tmpdir(), 'supremo-upload-race-'))
    const record = checkpoint()
    const queuePath = join(cwd, QUEUE_FILE)
    mkdirSync(dirname(queuePath), { recursive: true })
    writeFileSync(queuePath, serializeQueue([record]))
    vi.spyOn(changesetModule, 'defaultCommitReader').mockReturnValue(reader)
    vi.spyOn(validationModule, 'evidenceFor').mockReturnValue(evidence(record))
    const updated = { ...record, validationStatus: 'failed' as const,
      validationId: '44444444-4444-4444-8444-444444444444' }
    const client = fakeHttp(async () => {
      // A validation worker finishes while the upload request is in flight.
      appendFileSync(queuePath, serializeQueue([updated]))
      if (result === 'timeout') throw new NetworkError('timeout')
      return { prNumber: 17 }
    })
    try {
      expect(await drainOnce({ cwd, projectId: record.projectId, apiBaseUrl: 'https://supremo.example',
        getSecret: () => 'device-example' }, { http: client })).toBe(1)
      const latest = parseQueue(readFileSync(queuePath, 'utf8'))
      expect(latest).toHaveLength(1)
      expect(latest[0]).toMatchObject({
        checkpointId: record.checkpointId, commitSha: record.commitSha,
        validationStatus: 'failed', validationId: updated.validationId, validatedSha: record.commitSha,
        pushStatus: result === 'success' ? 'published' : 'upload_pending',
      })
    } finally { rmSync(cwd, { recursive: true, force: true }) }
  })
})
