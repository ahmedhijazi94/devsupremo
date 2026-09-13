import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildCheckpointRecord, parseQueue, QUEUE_FILE, serializeQueue } from './checkpoint'
import { DAEMON_PID_FILE, DAEMON_PROGRESS_FILE, daemonStatus, ensureDaemon, runDaemonLoop, type PublishInput } from './daemon'
import { writeJson } from './turn-workspace'

const directories: string[] = []
function workspace(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'supremo-upload-health-'))
  directories.push(cwd)
  fs.mkdirSync(path.dirname(path.join(cwd, DAEMON_PID_FILE)), { recursive: true })
  fs.writeFileSync(path.join(cwd, DAEMON_PID_FILE), String(process.pid))
  return cwd
}
afterEach(() => { for (const cwd of directories.splice(0)) fs.rmSync(cwd, { recursive: true, force: true }) })
const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
async function until(check: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('O daemon não avançou no prazo do teste')
    await pause(20)
  }
}

describe('saúde e recuperação do loop de envio', () => {
  it('detecta progresso vencido mesmo com worker vivo, sem iniciar um daemon duplicado', () => {
    const cwd = workspace()
    const health = { pid: process.pid, phase: 'publishing', updatedAt: new Date(Date.now() - 200_000).toISOString(),
      deadlineAt: new Date(Date.now() - 1).toISOString(), recoveredTimeouts: 0 }
    writeJson(path.join(cwd, DAEMON_PROGRESS_FILE), health)
    writeJson(path.join(cwd, '.supremo/validation/worker-health.json'), { pid: process.pid, checkedAt: Date.now() })
    expect(daemonStatus(cwd)).toMatchObject({ running: true, healthy: false })
    expect(ensureDaemon(cwd)).toBe('reuse')
    for (const phase of ['waiting', 'retrying']) {
      writeJson(path.join(cwd, DAEMON_PROGRESS_FILE), { ...health, phase, deadlineAt: new Date(Date.now() + 90_000).toISOString() })
      expect(daemonStatus(cwd)).toMatchObject({ running: true, healthy: true })
    }
    writeJson(path.join(cwd, DAEMON_PROGRESS_FILE), { ...health, pid: process.pid + 1 })
    expect(daemonStatus(cwd).healthy).toBe(false)
    fs.writeFileSync(path.join(cwd, DAEMON_PROGRESS_FILE), '{partial')
    expect(daemonStatus(cwd).healthy).toBe(false)
  })

  it('reenvia automaticamente após timeout, sem novo prompt, novo checkpoint ou alteração no app', async () => {
    const cwd = workspace()
    const git = (...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
    git('init', '-q')
    git('config', 'user.name', 'Recovery test')
    git('config', 'user.email', 'recovery@example.invalid')
    fs.writeFileSync(path.join(cwd, '.gitignore'), '.supremo/\n.env.local\n')
    fs.writeFileSync(path.join(cwd, 'app.txt'), 'antes\n')
    git('add', '.'); git('commit', '-qm', 'base')
    const baseSha = git('rev-parse', 'HEAD')
    fs.writeFileSync(path.join(cwd, 'app.txt'), 'app azul preservado\n')
    git('add', 'app.txt'); git('commit', '-qm', 'azul')
    const commitSha = git('rev-parse', 'HEAD')
    fs.writeFileSync(path.join(cwd, '.env.local'), 'EXAMPLE=preserved\n')
    const record = { ...buildCheckpointRecord({ checkpointId: '22222222-2222-4222-8222-222222222222',
      projectId: '11111111-1111-4111-8111-111111111111', commitSha, parentCheckpointId: null,
      createdAt: new Date().toISOString(), summary: 'Paleta azul', changedPaths: ['app.txt'] }),
      validationStatus: 'deferred' as const, validatedSha: commitSha, environment: 'development' as const,
      changesetBaseSha: baseSha, treeSha: git('rev-parse', 'HEAD^{tree}'), validationId: '33333333-3333-4333-8333-333333333333' }
    fs.writeFileSync(path.join(cwd, QUEUE_FILE), serializeQueue([record]))
    writeJson(path.join(cwd, '.supremo/validation', `${record.validationId}.json`), {
      id: record.validationId, projectId: record.projectId, checkpointId: record.checkpointId, sha: commitSha,
      baseSha, fingerprint: record.treeSha, environment: 'development', status: 'deferred',
      startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), summary: 'CI pendente', logs: '',
      checks: [], criterionIds: [], acceptanceCriteria: [],
    })
    const requests: PublishInput[] = []
    let stalledConnectionClosed = false
    const server = http.createServer((req, res) => {
      if (req.url !== '/api/checkpoint/publish') {
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ requests: [], reported: true, latest: null }))
        return
      }
      let body = ''
      req.setEncoding('utf8'); req.on('data', (chunk: string) => { body += chunk })
      req.on('end', () => {
        requests.push(JSON.parse(body) as PublishInput)
        if (requests.length === 1) {
          res.on('close', () => { stalledConnectionClosed = true })
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.write('{"prNumber":') // The worker stays alive; publication has stopped.
        } else {
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ prNumber: 17, published: true, idempotent: true }))
        }
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Sem porta')
    writeJson(path.join(cwd, '.supremo/project.json'), { projectId: record.projectId, supremoUrl: `http://127.0.0.1:${address.port}` })
    const controller = new AbortController()
    const loop = runDaemonLoop(cwd, { publishTimeoutMs: 150, idleMs: 20, getSecret: () => 'device-example', signal: controller.signal })
    try {
      await until(() => daemonStatus(cwd).upload?.recoveredTimeouts === 1)
      expect(daemonStatus(cwd)).toMatchObject({ healthy: true, upload: { phase: 'retrying' } })
      expect(fs.existsSync(path.join(cwd, '.supremo/validation/worker-health.json'))).toBe(true)
      await until(() => parseQueue(fs.readFileSync(path.join(cwd, QUEUE_FILE), 'utf8'))[0]?.pushStatus === 'published')
      expect(stalledConnectionClosed).toBe(true)
      expect(requests).toHaveLength(2)
      expect(requests[1]).toEqual(requests[0])
      expect(parseQueue(fs.readFileSync(path.join(cwd, QUEUE_FILE), 'utf8'))).toHaveLength(1)
      expect(git('rev-parse', 'HEAD')).toBe(commitSha)
      expect(git('status', '--porcelain')).toBe('')
      expect(fs.readFileSync(path.join(cwd, 'app.txt'), 'utf8')).toBe('app azul preservado\n')
      expect(fs.readFileSync(path.join(cwd, '.env.local'), 'utf8')).toBe('EXAMPLE=preserved\n')
      expect(fs.readFileSync(path.join(cwd, DAEMON_PROGRESS_FILE), 'utf8')).not.toContain('device-example')
    } finally {
      controller.abort()
      await loop
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  }, 15_000)
})
