import { execFile, execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import { acceptanceContractSchema } from './turn-acceptance'
import { FAILURE_TYPES, acceptanceCriterionSchema, classifyFailure } from './turn-model'
import { sanitizeDiagnostic } from '../../../src/lib/checkpoint/feedback'
import { defaultCheckpointDeps, type CheckpointRecord } from './checkpoint'
import { isKnownNextTsconfigNoise } from './restore'
import { captureTurnCheckpoint, gitText, readJson, TURN_DIR, withTurnLock, writeJson } from './turn-workspace'

const execute = promisify(execFile)
async function availableBrowserPort(): Promise<number> {
  const listener = net.createServer()
  return new Promise((resolve, reject) => {
    listener.once('error', reject)
    listener.listen(0, '127.0.0.1', () => {
      const address = listener.address()
      if (!address || typeof address === 'string') { listener.close(); reject(new Error('Porta de browser QA indisponível.')); return }
      listener.close((error) => error ? reject(error) : resolve(address.port))
    })
  })
}
export const VALIDATION_DIR = '.supremo/validation'
export const localEvidenceSchema = z.object({
  id: z.string().uuid(), projectId: z.string().uuid(), checkpointId: z.string().uuid(), sha: z.string().regex(/^[a-f0-9]{40}$/),
  fingerprint: z.string().regex(/^[a-f0-9]{40}$/), baseSha: z.string().regex(/^[a-f0-9]{40}$/), environment: z.enum(['development', 'production', 'unknown']),
  status: z.enum(['passed', 'failed', 'deferred']), startedAt: z.string().datetime(), finishedAt: z.string().datetime(),
  criterionIds: z.array(z.string()).default([]), acceptanceCriteria: z.array(acceptanceCriterionSchema).max(100).default([]),
  summary: z.string(), logs: z.string(), checks: z.array(z.object({
    name: z.string().min(1).max(200), status: z.enum(['passed', 'failed', 'deferred']), type: z.enum(FAILURE_TYPES).optional(),
  })).max(100),
})
export type LocalEvidence = z.infer<typeof localEvidenceSchema>

export function evidenceFor(cwd: string, record: CheckpointRecord): LocalEvidence | null {
  if (!record.validationId) return null
  const parsed = localEvidenceSchema.safeParse(readJson(path.join(cwd, VALIDATION_DIR, `${record.validationId}.json`)))
  if (!parsed.success) return null
  const item = parsed.data
  return item.id === record.validationId && item.projectId === record.projectId && item.checkpointId === record.checkpointId && item.sha === record.commitSha
    && item.environment === (record.environment ?? 'unknown') && Date.parse(item.finishedAt) >= Date.parse(item.startedAt)
    && item.baseSha === (record.changesetBaseSha ?? gitText(cwd, ['rev-parse', `${record.commitSha}^`]))
    && item.fingerprint === (record.treeSha ?? gitText(cwd, ['rev-parse', `${record.commitSha}^{tree}`])) ? item : null
}

/** Opt-in local QA. Secret transport checks are always enforced separately. */
export function localValidationMode(cwd: string): 'on_request' | 'background' {
  return z.object({ validation_mode: z.enum(['on_request', 'background']).default('on_request') })
    .parse(readJson(path.join(cwd, '.supremo/lifecycle.json')) ?? {}).validation_mode
}

function validationRequestFile(cwd: string, record: CheckpointRecord): string {
  return path.join(cwd, VALIDATION_DIR, 'requests', `${z.string().uuid().parse(record.checkpointId)}.json`)
}
function hasValidationRequest(cwd: string, record: CheckpointRecord): boolean {
  const request = z.object({ sha: z.string(), projectId: z.string() }).safeParse(readJson(validationRequestFile(cwd, record)))
  return request.success && request.data.sha === record.commitSha && request.data.projectId === record.projectId
}
export function requestCheckpointValidation(cwd: string, record: CheckpointRecord): void {
  writeJson(validationRequestFile(cwd, record), { projectId: record.projectId, sha: record.commitSha, requestedAt: new Date().toISOString() })
  const requested = { ...record, validationStatus: 'pending' as const }
  delete requested.validationId
  delete requested.validatedSha
  defaultCheckpointDeps(cwd).appendQueue(requested)
}

// Built into the CLI: changing an app's audit script cannot bypass the upload boundary.
// This fast static check is deliberately distinct from the full CI security audit.
const TRANSPORT_SECRET_PATTERNS = [
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{30,}\b/,
  /\bsbp_[a-f0-9]{40,}\b/,
  /\b(?:sb_secret_|sup_dev_ckpt_)[A-Za-z0-9_-]{20,}\b/,
  /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{32,}\b/,
  /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\./,
]

/** Reads immutable blobs in one bounded Git process. Never executes project code,
 * follows workspace symlinks, prints secret values, or marks unrequested QA passed. */
export function scanCheckpointForUpload(cwd: string, record: CheckpointRecord): LocalEvidence {
  const startedAt = new Date().toISOString()
  const fingerprint = gitText(cwd, ['rev-parse', `${record.commitSha}^{tree}`])
  const baseSha = record.changesetBaseSha ?? gitText(cwd, ['rev-parse', `${record.commitSha}^`])
  let status: LocalEvidence['status'] = 'deferred'
  let logs = 'Varredura de segredos do snapshot concluída. Testes locais não solicitados; gates de CI continuam pendentes.'
  try {
    if (record.environment !== 'development') throw new Error('Publicação requer ambiente de desenvolvimento autorizado.')
    const entries = gitText(cwd, ['ls-tree', '-r', '-z', record.commitSha]).split('\0').filter(Boolean).map((entry) => {
      const match = /^(\d+) (blob|commit) ([a-f0-9]{40})\t([\s\S]+)$/.exec(entry)
      if (!match || match[2] !== 'blob') throw new Error('Snapshot contém entrada não verificável para publicação.')
      const file = match[4]!
      if (/(^|\/)\.env(?:$|\.(?!(?:example|sample|template)$))/.test(file) || /(^|\/)(?:id_rsa|id_ed25519)$/.test(file)) {
        throw new Error('Snapshot contém arquivo reservado a credenciais locais.')
      }
      return { sha: match[3]!, file }
    })
    const hashes = [...new Set(entries.map((entry) => entry.sha))]
    const blobs = execFileSync('git', ['cat-file', '--batch'], { cwd, input: hashes.join('\n') + '\n',
      stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, timeout: 15_000 })
    let offset = 0
    for (const sha of hashes) {
      const end = blobs.indexOf(10, offset)
      if (end < 0) throw new Error('Leitura de snapshot incompleta.')
      const header = blobs.subarray(offset, end).toString('utf8').split(' ')
      const size = Number(header[2])
      if (header[0] !== sha || header[1] !== 'blob' || !Number.isSafeInteger(size) || size < 0 || end + size + 1 >= blobs.length) throw new Error('Blob inválido na varredura.')
      const content = blobs.subarray(end + 1, end + 1 + size).toString('utf8')
      if (TRANSPORT_SECRET_PATTERNS.some((pattern) => pattern.test(content))) throw new Error('Possível segredo encontrado no snapshot; publicação bloqueada. Conteúdo omitido.')
      offset = end + size + 2
    }
  } catch {
    // Child errors can retain stdout with the original blobs: never serialize them.
    status = 'failed'
    logs = 'Varredura de segredos não autorizou o upload: segredo, arquivo privado ou snapshot não verificável. Conteúdo omitido; preview preservado.'
  }
  const evidence: LocalEvidence = { id: crypto.randomUUID(), projectId: record.projectId, checkpointId: record.checkpointId,
    sha: record.commitSha, fingerprint, baseSha, environment: record.environment ?? 'unknown', status,
    startedAt, finishedAt: new Date().toISOString(), criterionIds: [], acceptanceCriteria: [], logs,
    summary: status === 'deferred' ? 'Segredos verificados; validação funcional não solicitada, CI pendente.' : 'Publicação bloqueada pela varredura de segredos.',
    checks: [{ name: 'secret scan', type: 'security', status: status === 'failed' ? 'failed' : 'passed' }] }
  writeJson(path.join(cwd, VALIDATION_DIR, `${evidence.id}.json`), evidence)
  return evidence
}

const verifyReportSchema = z.object({
  sha: z.string().regex(/^[a-f0-9]{40}$/), base: z.string().regex(/^[a-f0-9]{40}$/),
  status: z.enum(['passed', 'failed', 'deferred']), checks: localEvidenceSchema.shape.checks.min(1),
}).superRefine((report, context) => {
  const expected = report.checks.some((check) => check.status === 'failed') ? 'failed'
    : report.checks.some((check) => check.status === 'deferred') ? 'deferred' : 'passed'
  if (report.status !== expected || new Set(report.checks.map((check) => check.name)).size !== report.checks.length) {
    context.addIssue({ code: 'custom', message: 'Status de validação inconsistente com os checks executados.' })
  }
})

/** I/O adapter: exact immutable Git worktree, private output and independent .next. */
export async function validateCheckpoint(cwd: string, record: CheckpointRecord): Promise<LocalEvidence> {
  const startedAt = new Date().toISOString()
  const id = crypto.randomUUID()
  const scratch = path.join(cwd, VALIDATION_DIR, `work-${id}`)
  fs.mkdirSync(path.dirname(scratch), { recursive: true, mode: 0o700 })
  let added = false
  let logs = ''
  let status: LocalEvidence['status'] = 'failed'
  let checks: LocalEvidence['checks'] = []
  let criterionIds: string[] = []
  let acceptanceCriteria: LocalEvidence['acceptanceCriteria'] = []
  const fingerprint = gitText(cwd, ['rev-parse', `${record.commitSha}^{tree}`])
  const baseSha = record.changesetBaseSha ?? gitText(cwd, ['rev-parse', `${record.commitSha}^`])
  try {
    if (record.environment === 'production') throw new Error('Validação automática de produção bloqueada.')
    execFileSync('git', ['worktree', 'add', '--detach', scratch, record.commitSha], { cwd, stdio: 'pipe' })
    added = true
    // Dependencies are reused, build/test outputs remain isolated. Never copy .env or device identity.
    if (fs.existsSync(path.join(cwd, 'node_modules'))) fs.symlinkSync(path.join(cwd, 'node_modules'), path.join(scratch, 'node_modules'), 'dir')
    const script = path.join(scratch, 'scripts/verify.mjs')
    if (!fs.existsSync(script)) throw new Error('Worker indisponível: scripts/verify.mjs ausente.')
    const env: NodeJS.ProcessEnv = {
      PATH: `${path.join(cwd, 'node_modules/.bin')}${path.delimiter}${process.env.PATH ?? ''}`,
      HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, CI: 'true',
      NEXT_TELEMETRY_DISABLED: '1', SUPREMO_VALIDATION: '1',
      // Anonymous UI smoke can instantiate the SDK and prove the login redirect.
      // These are synthetic, unusable for authentication or any remote database.
      NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:9',
      NEXT_PUBLIC_SUPABASE_ANON_KEY: 'supremo-synthetic-smoke-key',
    }
    const acceptanceRaw = readJson(path.join(scratch, '.supremo/acceptance.json'))
    const acceptance = acceptanceRaw === null ? null : acceptanceContractSchema.parse(acceptanceRaw)
    acceptanceCriteria = acceptance?.criteria ?? []
    if (fs.existsSync(path.join(scratch, 'e2e/smoke.spec.ts')) || acceptance?.checks.some((check) => check.type === 'e2e')) {
      env.PLAYWRIGHT_PORT = String(await availableBrowserPort())
    }
    const parent = baseSha
    let executionFailed = false
    try {
      const result = await execute(process.execPath, [script, '--base', parent, '--background', ...(record.draft ? ['--draft'] : [])], {
        cwd: scratch, env, timeout: 10 * 60_000, maxBuffer: 4 * 1024 * 1024,
      })
      logs = `${result.stdout}\n${result.stderr}`
    } catch (error) {
      const failure = error as Error & { stdout?: string; stderr?: string }
      logs = `${failure.stdout ?? ''}\n${failure.stderr ?? ''}\n${failure.message}`
      executionFailed = true
    }
    const report = verifyReportSchema.safeParse(readJson(path.join(scratch, '.supremo/verify-result.json')))
    if (!report.success) throw new Error('Verify terminou sem evidência estruturada; aprovação recusada.')
    if (report.data.sha !== record.commitSha || report.data.base !== parent) throw new Error('Evidência de verify pertence a outro SHA/base.')
    status = report.data.status
    checks = report.data.checks.map((check) => ({ ...check, type: check.type ?? classifyFailure(check.name, 'code') }))
    if (executionFailed || status === 'failed') throw new Error('Verify falhou; checks e diagnóstico preservados.')
    // Validation must not rewrite the input tree, even in isolation.
    if (acceptance !== null) {
      const contract = acceptance
      for (const check of contract.checks) {
        if (check.files.some((file) => !fs.existsSync(path.join(scratch, file)))) throw new Error('Critério sem arquivo de prova executável.')
        if (check.type === 'rls') {
          checks.push({ name: check.name, type: check.type, status: 'deferred' }); status = 'deferred'; continue
        }
        const bin = path.join(cwd, 'node_modules/.bin', check.type === 'unit' ? 'vitest' : 'playwright')
        try {
          const selected = await execute(bin, [check.type === 'unit' ? 'run' : 'test', ...check.files], {
            cwd: scratch, env, timeout: 5 * 60_000, maxBuffer: 4 * 1024 * 1024,
          })
          logs += '\n' + selected.stdout + '\n' + selected.stderr
          checks.push({ name: check.name, type: check.type, status: 'passed' })
        } catch (error) {
          checks.push({ name: check.name, type: check.type, status: 'failed' })
          throw error
        }
      }
      criterionIds = contract.criteria.filter((criterion) => criterion.requiredChecks.every((name) =>
        checks.some((check) => check.name === name && check.status === 'passed'))).map((criterion) => criterion.id)
    }
    const after = gitText(scratch, ['diff', '--name-only', '-z', 'HEAD']).split('\0').filter(Boolean)
    if (after.some((file) => file !== 'next-env.d.ts' && !(file === 'tsconfig.json' && isKnownNextTsconfigNoise(
      gitText(scratch, ['show', 'HEAD:tsconfig.json']), fs.readFileSync(path.join(scratch, file), 'utf8'),
    )))) {
      status = 'failed'; logs += '\nValidação alterou arquivos versionados.'
    }
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string }
    logs += `\n${failure.stdout ?? ''}\n${failure.stderr ?? ''}\n${failure.message}`
    status = 'failed'
  } finally {
    if (added) {
      try { execFileSync('git', ['worktree', 'remove', '--force', scratch], { cwd, stdio: 'pipe' }) }
      catch { logs += '\nCleanup da validação pendente; preview preservado.' }
    }
  }
  const evidence: LocalEvidence = { id, projectId: record.projectId, checkpointId: record.checkpointId,
    sha: record.commitSha, fingerprint, baseSha, environment: record.environment ?? 'unknown', status,
    startedAt, finishedAt: new Date().toISOString(),
    summary: status === 'passed' ? 'Validação local concluída.' : status === 'deferred'
      ? 'Gates remotos ainda obrigatórios.' : 'Validação local falhou.',
    logs: sanitizeDiagnostic(logs), checks: checks.map((check) => ({ ...check, name: sanitizeDiagnostic(check.name).slice(0, 200) })), criterionIds, acceptanceCriteria }
  writeJson(path.join(cwd, VALIDATION_DIR, `${id}.json`), evidence)
  return evidence
}

/** One owner across daemon restarts. An interrupted running check is revalidated. */
export async function drainLocalValidation(cwd: string): Promise<number> {
  const lock = path.join(cwd, VALIDATION_DIR, 'worker.json')
  fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 })
  try { fs.writeFileSync(lock, JSON.stringify({ pid: process.pid }), { flag: 'wx', mode: 0o600 }) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const existing = z.object({ pid: z.number().int().positive() }).safeParse(readJson(lock))
    if (!existing.success) throw new Error('Lease do worker inválido; não é seguro assumir sua posse.')
    try { process.kill(existing.data.pid, 0); return 0 }
    catch (probe) {
      if ((probe as NodeJS.ErrnoException).code !== 'ESRCH') return 0
      fs.unlinkSync(lock)
      return drainLocalValidation(cwd)
    }
  }
  try {
    const deps = defaultCheckpointDeps(cwd)
    // Pending legacy records stay visible until preflight confirms their environment.
    // Missing authority is not evidence of a code/secret failure.
    const record = deps.readQueue().find((item) => item.environment !== undefined && item.environment !== 'unknown' &&
      (item.validationStatus === 'pending' || item.validationStatus === 'running' || hasValidationRequest(cwd, item)))
    if (!record) return localValidationMode(cwd) === 'background' ? await validateDraft(cwd) : 0
    deps.appendQueue({ ...record, validationStatus: 'running' })
    const requested = hasValidationRequest(cwd, record)
    const transport = scanCheckpointForUpload(cwd, record)
    const evidence = transport.status === 'failed' || !(requested || localValidationMode(cwd) === 'background')
      ? transport : await validateCheckpoint(cwd, record)
    if (requested) fs.rmSync(validationRequestFile(cwd, record), { force: true })
    const latest = deps.readQueue().find((item) => item.checkpointId === record.checkpointId) ?? record
    deps.appendQueue({ ...latest, validationStatus: evidence.status, validationId: evidence.id, validatedSha: evidence.sha })
    return 1
  } finally { fs.unlinkSync(lock) }
}

/** Debounced saves are validated without publishing intermediate work or touching HEAD. */
async function validateDraft(cwd: string): Promise<number> {
  const requestFile = path.join(cwd, TURN_DIR, 'validation-request.json')
  const request = z.object({ turnId: z.string(), dueAt: z.number() }).safeParse(readJson(requestFile))
  if (!request.success || request.data.dueAt > Date.now()) return 0
  const draft = await withTurnLock(cwd, () => {
    // The tool holds its lease throughout actual filesystem writes, outside the lifecycle lock.
    if (readJson(path.join(cwd, TURN_DIR, 'mutation-lease.json')) !== null) return null
    const currentRequest = z.object({ turnId: z.string(), dueAt: z.number() }).safeParse(readJson(requestFile))
    if (!currentRequest.success || currentRequest.data.turnId !== request.data.turnId || currentRequest.data.dueAt > Date.now()) return null
    const state = z.object({ turn: z.object({ turnId: z.string(), projectId: z.string(),
      environment: z.enum(['development', 'production', 'unknown']), status: z.string() }) })
      .safeParse(readJson(path.join(cwd, TURN_DIR, 'state.json')))
    if (!state.success || state.data.turn.turnId !== request.data.turnId || state.data.turn.status !== 'active') return null
    const captured = captureTurnCheckpoint(cwd, { ...state.data.turn, summary: 'Validação das alterações em andamento', draft: true })
    fs.unlinkSync(requestFile)
    return captured
  })
  if (!draft) return 0
  const previous = readJson(path.join(cwd, VALIDATION_DIR, 'draft.json')) as CheckpointRecord | null
  if (previous && previous.treeSha === draft.treeSha && previous.validationStatus !== 'running') return 0
  writeJson(path.join(cwd, VALIDATION_DIR, 'draft.json'), { ...draft, validationStatus: 'running' })
  const evidence = await validateCheckpoint(cwd, draft)
  writeJson(path.join(cwd, VALIDATION_DIR, 'draft.json'), { ...draft,
    validationStatus: evidence.status, validationId: evidence.id, validatedSha: evidence.sha })
  return 1
}

export function validationWorkerHealthy(cwd: string): boolean {
  const health = z.object({ protocolVersion: z.literal(1), pid: z.number().int().positive(), checkedAt: z.number() })
    .safeParse(readJson(path.join(cwd, VALIDATION_DIR, 'worker-health.json')))
  if (!health.success || Date.now() - health.data.checkedAt > 15000 || health.data.checkedAt > Date.now() + 1000) return false
  try { process.kill(health.data.pid, 0); return true }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
}

export function startLocalValidationWorker(cwd: string): () => void {
  let stopped = false
  const heartbeat = (): void => writeJson(path.join(cwd, VALIDATION_DIR, 'worker-health.json'), { protocolVersion: 1, pid: process.pid, checkedAt: Date.now() })
  heartbeat()
  const heartbeatTimer = setInterval(heartbeat, 5000)
  let timer: ReturnType<typeof setTimeout> | undefined
  const tick = async (): Promise<void> => {
    try { await drainLocalValidation(cwd) }
    catch (error) { console.error('[validation]', sanitizeDiagnostic(error instanceof Error ? error.message : String(error))) }
    if (!stopped) timer = setTimeout(() => { void tick() }, 1200)
  }
  void tick()
  return () => { stopped = true; clearInterval(heartbeatTimer); if (timer) clearTimeout(timer) }
}
