import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { z } from 'zod'
import { acceptanceContractSchema } from './turn-acceptance'
import { FAILURE_TYPES, acceptanceCriterionSchema, classifyFailure } from './turn-model'
import { sanitizeDiagnostic } from '../../../src/lib/checkpoint/feedback'
import { defaultCheckpointDeps, type CheckpointRecord } from './checkpoint'
import { isKnownNextTsconfigNoise } from './restore'
import { linkIsolatedDependencies, readProjectStack, syntheticValidationEnvironment } from './framework-runtime'
import { captureTurnCheckpoint, gitText, readJson, TURN_DIR, withTurnLock, writeJson } from './turn-workspace'

import { automaticValidation, readEnginePolicy } from './engine-policy'
import { runWorkerProcess, WorkerAbortedError, WorkerInfrastructureError, WorkerOutputLimitError, WorkerTimeoutError } from './worker-process'
import { verifyTrustedFiles } from './trusted-validation'
import { TRUSTED_VALIDATION_POLICIES } from './generated/validation-policy'
import { readStableFile } from './stable-file'
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
const checkFailureReasonSchema = z.enum(['timeout', 'transient_infrastructure', 'interrupted', 'code', 'security'])
const failureReasonSchema = z.enum([...checkFailureReasonSchema.options, 'invalid_evidence', 'infrastructure', 'output_limit'])
type ValidationFailureReason = z.infer<typeof failureReasonSchema>
export const localEvidenceSchema = z.object({
  id: z.string().uuid(), projectId: z.string().uuid(), checkpointId: z.string().uuid(), sha: z.string().regex(/^[a-f0-9]{40}$/),
  fingerprint: z.string().regex(/^[a-f0-9]{40}$/), baseSha: z.string().regex(/^[a-f0-9]{40}$/), environment: z.enum(['development', 'production', 'unknown']),
  status: z.enum(['passed', 'failed', 'deferred']), startedAt: z.string().datetime(), finishedAt: z.string().datetime(),
  criterionIds: z.array(z.string()).default([]), acceptanceCriteria: z.array(acceptanceCriterionSchema).max(100).default([]),
  summary: z.string(), logs: z.string(), checks: z.array(z.object({
    name: z.string().min(1).max(200), status: z.enum(['passed', 'failed', 'deferred']), type: z.enum(FAILURE_TYPES).optional(),
    failureReason: checkFailureReasonSchema.optional(),
  })).max(100),
  failureReason: failureReasonSchema.optional(),
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

/** Background checks are the default; an explicit on_request policy opts out. */
export function localValidationMode(cwd: string): 'on_request' | 'background_adaptive' {
  return automaticValidation(cwd) ? 'background_adaptive' : 'on_request'
}

function validationRequestFile(cwd: string, record: CheckpointRecord): string {
  return path.join(cwd, VALIDATION_DIR, 'requests', `${z.string().uuid().parse(record.checkpointId)}.json`)
}
function validationRequestToken(cwd: string, record: CheckpointRecord): string | null {
  const request = z.object({ sha: z.string(), projectId: z.string(), requestId: z.string().uuid().optional(), requestedAt: z.string().datetime() })
    .safeParse(readJson(validationRequestFile(cwd, record)))
  return request.success && request.data.sha === record.commitSha && request.data.projectId === record.projectId
    ? request.data.requestId ?? request.data.requestedAt : null
}
function hasValidationRequest(cwd: string, record: CheckpointRecord): boolean { return validationRequestToken(cwd, record) !== null }
export function requestCheckpointValidation(cwd: string, record: CheckpointRecord): void {
  writeJson(validationRequestFile(cwd, record), { projectId: record.projectId, sha: record.commitSha, requestId: crypto.randomUUID(), requestedAt: new Date().toISOString() })
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
  failureReason: checkFailureReasonSchema.optional(),
}).superRefine((report, context) => {
  const expected = report.checks.some((check) => check.status === 'failed') ? 'failed'
    : report.checks.some((check) => check.status === 'deferred') ? 'deferred' : 'passed'
  if (report.status !== expected || new Set(report.checks.map((check) => check.name)).size !== report.checks.length) {
    context.addIssue({ code: 'custom', message: 'Status de validação inconsistente com os checks executados.' })
  }
})

const verifyProgressSchema = z.object({
  version: z.literal(1), sha: z.string().regex(/^[a-f0-9]{40}$/), base: z.string().regex(/^[a-f0-9]{40}$/),
  status: z.enum(['running', 'passed', 'failed', 'deferred']), checks: localEvidenceSchema.shape.checks,
  activeChecks: z.array(z.object({ name: z.string().min(1).max(200), type: z.enum(FAILURE_TYPES).optional(), startedAt: z.string().datetime() })).max(100),
  failureReason: checkFailureReasonSchema.optional(),
}).superRefine((report, context) => {
  const names = [...report.checks, ...report.activeChecks].map(check => check.name)
  if (names.length > 100 || new Set(names).size !== names.length) context.addIssue({ code: 'custom', message: 'Etapas duplicadas ou excessivas no progresso.' })
})
class InvalidVerifyEvidenceError extends Error {
  constructor() { super('Verify terminou sem evidência estruturada válida para este SHA/base; aprovação recusada.') }
}
function readVerifyFile(scratch: string, name: string): unknown | null {
  const file = path.join(scratch, '.supremo', name)
  if (!fs.lstatSync(file, { throwIfNoEntry: false })) return null
  try { return JSON.parse(readStableFile(file, 256 * 1024, scratch).content) as unknown }
  catch { throw new InvalidVerifyEvidenceError() }
}
function normalizeCheck(check: LocalEvidence['checks'][number]): LocalEvidence['checks'][number] {
  return { ...check, type: check.failureReason && ['timeout', 'transient_infrastructure', 'interrupted'].includes(check.failureReason)
    ? 'external_dependency' : check.type ?? classifyFailure(check.name, 'code') }
}
function workerFailureReason(error: unknown): ValidationFailureReason | null {
  return error instanceof WorkerTimeoutError ? 'timeout' : error instanceof WorkerInfrastructureError ? 'transient_infrastructure'
    : error instanceof WorkerOutputLimitError ? 'output_limit' : error instanceof InvalidVerifyEvidenceError ? 'invalid_evidence' : null
}
function reasonWithKnownFailures(checks: LocalEvidence['checks'], fallback: ValidationFailureReason): ValidationFailureReason {
  const failed = checks.filter(check => check.status === 'failed' && !['timeout', 'transient_infrastructure', 'interrupted'].includes(check.failureReason ?? ''))
  if (failed.some(check => check.type === 'security' || check.failureReason === 'security')) return 'security'
  if (failed.some(check => check.type !== 'external_dependency')) return 'code'
  return fallback
}

/** I/O adapter: exact immutable Git worktree, private output and independent .next. */
export async function validateCheckpoint(cwd: string, record: CheckpointRecord, signal?: AbortSignal): Promise<LocalEvidence> {
  const limits = readEnginePolicy(cwd).validation
  const deadline = Date.now() + limits.timeout_ms
  const remaining = (): number => Math.max(1, deadline - Date.now())
  const startedAt = new Date().toISOString()
  const id = crypto.randomUUID()
  const scratch = path.join(cwd, VALIDATION_DIR, `work-${id}`)
  fs.mkdirSync(path.dirname(scratch), { recursive: true, mode: 0o700 })
  let added = false
  let logs = ''
  let status: LocalEvidence['status'] = 'failed'
  let failureReason: ValidationFailureReason | undefined
  let checks: LocalEvidence['checks'] = []
  let failedStage: LocalEvidence['checks'][number] = { name: 'validation infrastructure', type: 'external_dependency', status: 'failed' }
  let criterionIds: string[] = []
  let acceptanceCriteria: LocalEvidence['acceptanceCriteria'] = []
  const fingerprint = gitText(cwd, ['rev-parse', `${record.commitSha}^{tree}`])
  const baseSha = record.changesetBaseSha ?? gitText(cwd, ['rev-parse', `${record.commitSha}^`])
  try {
    if (record.environment !== 'development') throw new Error('Validação requer ambiente de desenvolvimento autorizado.')
    if (signal?.aborted) throw new WorkerAbortedError()
    execFileSync('git', ['worktree', 'add', '--detach', scratch, record.commitSha], { cwd, stdio: 'pipe' })
    added = true
    failedStage = { name: 'validation integrity', type: 'security', status: 'failed' }
    verifyTrustedFiles(scratch)
    const stack = readProjectStack(scratch)
    failedStage = { name: 'validation infrastructure', type: 'external_dependency', status: 'failed' }
    // Dependencies are reused, build/test outputs remain isolated. Never copy
    // .env or device identity; Start caches must not write into live node_modules.
    if (fs.existsSync(path.join(cwd, 'node_modules'))) {
      if (stack === 'tanstack-start-vite') await linkIsolatedDependencies(cwd, scratch, { signal, deadline })
      else fs.symlinkSync(path.join(cwd, 'node_modules'), path.join(scratch, 'node_modules'), 'dir')
    }
    failedStage = { name: 'validation infrastructure', type: 'external_dependency', status: 'failed' }
    const script = path.join(scratch, 'scripts/verify.mjs')
    if (!fs.existsSync(script)) throw new Error('Worker indisponível: scripts/verify.mjs ausente.')
    const env: NodeJS.ProcessEnv = {
      PATH: `${path.join(stack === 'tanstack-start-vite' ? scratch : cwd, 'node_modules/.bin')}${path.delimiter}${process.env.PATH ?? ''}`,
      HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, CI: 'true',
      NEXT_TELEMETRY_DISABLED: '1', SUPREMO_VALIDATION: '1',
      // Anonymous UI smoke can instantiate the SDK and prove the login redirect.
      // These are synthetic, unusable for authentication or any remote database.
      ...syntheticValidationEnvironment(stack),
    }
    failedStage = { name: 'acceptance contract', type: 'code', status: 'failed' }
    const acceptancePath = path.join(scratch, '.supremo/acceptance.json')
    const acceptance = fs.lstatSync(acceptancePath, { throwIfNoEntry: false }) ? acceptanceContractSchema.parse(JSON.parse(
      readStableFile(acceptancePath, 256 * 1024, scratch).content,
    )) : null
    // Validate proof files before executing a worker. A path accepted by the
    // contract must also be a regular file inside this immutable checkout.
    for (const check of acceptance?.checks ?? []) {
      for (const file of check.files) {
        try { readStableFile(path.join(scratch, file), 16 * 1024 * 1024, scratch) }
        catch { throw new Error(`Critério sem arquivo de prova regular no snapshot: ${file}`) }
      }
    }
    acceptanceCriteria = acceptance?.criteria ?? []
    failedStage = { name: 'validation infrastructure', type: 'external_dependency', status: 'failed' }
    if (fs.existsSync(path.join(scratch, 'e2e/smoke.spec.ts')) || acceptance?.checks.some((check) => check.type === 'e2e')) {
      env.PLAYWRIGHT_PORT = String(await availableBrowserPort())
    }
    const parent = baseSha
    let executionError: unknown = null
    try {
      const result = await runWorkerProcess(process.execPath, [script, '--base', parent, '--background', ...(record.draft ? ['--draft'] : [])], {
        cwd: scratch, env, timeoutMs: remaining(), maxOutputBytes: limits.max_output_bytes, signal,
      })
      logs = `${result.stdout}\n${result.stderr}`
    } catch (error) {
      if (error instanceof WorkerAbortedError) throw error
      const failure = error as Error & { stdout?: string; stderr?: string }
      logs = `${failure.stdout ?? ''}\n${failure.stderr ?? ''}\n${failure.message}`
      executionError = error
    }
    const rawReport = readVerifyFile(scratch, 'verify-result.json')
    const report = verifyReportSchema.safeParse(rawReport)
    if (!report.success) {
      const running = z.object({ schemaVersion: z.literal(1), sha: z.string(), base: z.string(), status: z.literal('running'), checks: localEvidenceSchema.shape.checks }).safeParse(rawReport)
      // Older trusted verifiers write an initial running report. It is partial
      // evidence only, never equivalent to a completed validation.
      if (rawReport !== null && !running.success) throw new InvalidVerifyEvidenceError()
      const rawProgress = readVerifyFile(scratch, 'verify-progress.json') ?? (running.success
        ? { ...running.data, version: 1, activeChecks: [] } : null)
      if (rawProgress !== null) {
        const progress = verifyProgressSchema.safeParse(rawProgress)
        if (!progress.success || progress.data.sha !== record.commitSha || progress.data.base !== parent) throw new InvalidVerifyEvidenceError()
        checks = progress.data.checks.map(normalizeCheck)
        for (const check of progress.data.activeChecks) {
          checks.push({ name: check.name, type: 'external_dependency', status: 'failed',
            failureReason: executionError instanceof WorkerTimeoutError ? 'timeout' : 'interrupted' })
        }
        logs += `\nProgresso parcial preservado: ${progress.data.checks.map(check => `${check.name}: ${check.status}`).join('; ') || 'nenhuma etapa concluída'}.`
        if (progress.data.activeChecks.length) logs += `\nEtapas interrompidas: ${progress.data.activeChecks.map(check => check.name).join(', ')}.`
      }
      const reason = workerFailureReason(executionError)
      if (!reason) throw new InvalidVerifyEvidenceError()
      failureReason = reasonWithKnownFailures(checks, reason)
      if (!checks.some(check => check.status === 'failed')) checks.push({ name: 'validation infrastructure', type: 'external_dependency', status: 'failed',
        ...(reason === 'timeout' || reason === 'transient_infrastructure' ? { failureReason: reason } : {}) })
      throw executionError
    }
    if (report.data.sha !== record.commitSha || report.data.base !== parent) throw new InvalidVerifyEvidenceError()
    status = report.data.status
    checks = report.data.checks.map(normalizeCheck)
    if (executionError !== null || status === 'failed') {
      const reason = workerFailureReason(executionError) ?? report.data.failureReason
        ?? checks.find(check => check.status === 'failed' && check.failureReason)?.failureReason ?? 'code'
      failureReason = reasonWithKnownFailures(checks, reason)
      // A passing report cannot turn a timed out/nonzero process into approval.
      if (!checks.some(check => check.status === 'failed')) checks.push({ name: 'validation infrastructure', type: 'external_dependency', status: 'failed',
        ...(reason === 'timeout' || reason === 'transient_infrastructure' ? { failureReason: reason } : {}) })
      throw new Error('Verify falhou; checks e diagnóstico preservados.')
    }
    // Validation must not rewrite the input tree, even in isolation.
    if (acceptance !== null) {
      const contract = acceptance
      for (const check of contract.checks) {
        if (check.type === 'rls') {
          checks.push({ name: check.name, type: check.type, status: 'deferred' }); status = 'deferred'; continue
        }
        const bin = path.join(stack === 'tanstack-start-vite' ? scratch : cwd, 'node_modules/.bin', check.type === 'unit' ? 'vitest' : 'playwright')
        try {
          const selected = await runWorkerProcess(bin, [check.type === 'unit' ? 'run' : 'test', ...check.files], {
            cwd: scratch, env, timeoutMs: remaining(), maxOutputBytes: limits.max_output_bytes, signal,
          })
          logs += '\n' + selected.stdout + '\n' + selected.stderr
          checks.push({ name: check.name, type: check.type, status: 'passed' })
        } catch (error) {
          const reason = workerFailureReason(error)
          checks.push({ name: check.name, type: reason ? 'external_dependency' : check.type, status: 'failed',
            ...(reason === 'timeout' || reason === 'transient_infrastructure' ? { failureReason: reason } : {}) })
          throw error
        }
      }
      criterionIds = contract.criteria.filter((criterion) => criterion.requiredChecks.every((name) =>
        checks.some((check) => check.name === name && check.status === 'passed'))).map((criterion) => criterion.id)
    }
    const after = gitText(scratch, ['diff', '--name-only', '-z', 'HEAD']).split('\0').filter(Boolean)
    if (after.some((file) => (stack === 'tanstack-start-vite' || file !== 'next-env.d.ts') && !(stack !== 'tanstack-start-vite' && file === 'tsconfig.json' && isKnownNextTsconfigNoise(
      gitText(scratch, ['show', 'HEAD:tsconfig.json']), fs.readFileSync(path.join(scratch, file), 'utf8'),
    )))) {
      status = 'failed'; failureReason = 'security'; checks.push({ name: 'validation integrity', type: 'security', status: 'failed' }); logs += '\nValidação alterou arquivos versionados.'
    }
  } catch (error) {
    if (error instanceof WorkerAbortedError) throw error
    const failure = error as Error & { stdout?: string; stderr?: string }
    logs += `\n${failure.stdout ?? ''}\n${failure.stderr ?? ''}\n${failure.message}`
    status = 'failed'
    failureReason ??= workerFailureReason(error) ?? (failedStage.type === 'security' ? 'security' : failedStage.type === 'code' ? 'code' : 'infrastructure')
    failureReason = reasonWithKnownFailures(checks, failureReason)
    if (!checks.some(check => check.status === 'failed')) checks = [...checks.slice(0, 99), { ...failedStage,
      ...(failureReason === 'timeout' || failureReason === 'transient_infrastructure' ? { failureReason } : {}) }]
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
      ? 'Gates remotos ainda obrigatórios.' : failureReason === 'timeout' ? 'Validação interrompida por tempo excedido; aprovação pendente.' : 'Validação local falhou.',
    logs: sanitizeDiagnostic(logs), checks: checks.map((check) => ({ ...check, name: sanitizeDiagnostic(check.name).slice(0, 200) })), criterionIds, acceptanceCriteria,
    ...(failureReason ? { failureReason } : {}) }
  writeJson(path.join(cwd, VALIDATION_DIR, `${id}.json`), evidence)
  return evidence
}

export type ValidationJobStatus = 'running' | 'passed' | 'failed' | 'deferred' | 'superseded' | 'cancelled'
function writeJob(cwd: string, record: CheckpointRecord, status: ValidationJobStatus, retry?: { attempts: number; nextAttemptAt?: number }): void {
  writeJson(path.join(cwd, VALIDATION_DIR, 'jobs', `${record.checkpointId}.json`), {
    checkpointId: record.checkpointId, sha: record.commitSha, base: record.changesetBaseSha ?? gitText(cwd, ['rev-parse', `${record.commitSha}^`]),
    status, updatedAt: new Date().toISOString(), draft: record.draft === true, ...retry,
  })
}

const attemptStateSchema = z.object({
  version: z.literal(1), key: z.string().regex(/^[a-f0-9]{64}$/), requestToken: z.string().nullable(),
  attempts: z.number().int().min(0).max(3), status: z.enum(['running', 'waiting', 'completed', 'exhausted']),
  nextAttemptAt: z.number().int().nonnegative(), evidence: localEvidenceSchema.nullable(),
})
type ValidationAttemptState = z.infer<typeof attemptStateSchema>
function retryableValidation(evidence: LocalEvidence): boolean {
  return evidence.status === 'failed' && ['timeout', 'transient_infrastructure'].includes(evidence.failureReason ?? '')
    && evidence.checks.filter(check => check.status === 'failed').every(check =>
      check.type === 'external_dependency' && ['timeout', 'transient_infrastructure', 'interrupted'].includes(check.failureReason ?? ''))
}
function waitForRetry(delay: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new WorkerAbortedError()); return }
    const abort = (): void => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new WorkerAbortedError()) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, Math.max(0, delay))
    signal.addEventListener('abort', abort, { once: true })
  })
}
function exhaustedValidation(cwd: string, record: CheckpointRecord, transport: LocalEvidence, previous: LocalEvidence | null): LocalEvidence {
  const now = new Date().toISOString()
  const evidence: LocalEvidence = { ...(previous ?? transport), id: crypto.randomUUID(), checkpointId: record.checkpointId,
    status: 'failed', ...(previous ? {} : { startedAt: now, finishedAt: now, criterionIds: [],
      checks: [{ name: 'validation infrastructure', type: 'external_dependency', status: 'failed', failureReason: 'interrupted' }],
      failureReason: 'interrupted', logs: 'As tentativas anteriores foram interrompidas. O orçamento persistido impede reiniciar indefinidamente o mesmo snapshot.' }),
    summary: 'Validação não concluída; tentativas automáticas esgotadas. Solicite nova validação para tentar novamente.' }
  writeJson(path.join(cwd, VALIDATION_DIR, `${evidence.id}.json`), evidence)
  return evidence
}
function invalidAttemptEvidence(cwd: string, transport: LocalEvidence): LocalEvidence {
  const now = new Date().toISOString()
  const evidence: LocalEvidence = { ...transport, id: crypto.randomUUID(), status: 'failed', startedAt: now, finishedAt: now,
    failureReason: 'invalid_evidence', checks: [{ name: 'validation infrastructure', type: 'external_dependency', status: 'failed' }],
    summary: 'Estado de tentativas inválido; validação recusada.',
    logs: 'O estado persistido de tentativas está inválido ou pertence a outro snapshot. Nenhum processo foi iniciado; o orçamento não foi reiniciado.' }
  writeJson(path.join(cwd, VALIDATION_DIR, `${evidence.id}.json`), evidence)
  return evidence
}

/** Cache reuse requires the same immutable commit, diff base, environment and validation plan. */
async function executeScheduledValidation(cwd: string, record: CheckpointRecord, transport: LocalEvidence, signal?: AbortSignal, requested = false): Promise<LocalEvidence> {
  const limits = readEnginePolicy(cwd).validation
  const key = crypto.createHash('sha256').update(JSON.stringify({ projectId: record.projectId, sha: record.commitSha, base: transport.baseSha,
    environment: record.environment, draft: record.draft === true, trustedPolicy: TRUSTED_VALIDATION_POLICIES, validation: readEnginePolicy(cwd).validation })).digest('hex')
  const cacheFile = path.join(cwd, VALIDATION_DIR, 'cache', `${key}.json`)
  let cacheInput: unknown = null
  try { cacheInput = readJson(cacheFile) }
  catch { cacheInput = null /* A corrupt cache is not reusable evidence; durable launch accounting remains authoritative. */ }
  const cached = localEvidenceSchema.safeParse(cacheInput)
  // Never treat a failed run as a reusable proof, especially on an explicit request.
  if (cached.success && cached.data.status !== 'failed' && cached.data.projectId === record.projectId && cached.data.environment === record.environment
    && cached.data.fingerprint === transport.fingerprint && cached.data.checkpointId === record.checkpointId && cached.data.sha === record.commitSha && cached.data.baseSha === transport.baseSha) {
    writeJob(cwd, record, cached.data.status); return cached.data
  }
  const attemptFile = path.join(cwd, VALIDATION_DIR, 'attempts', `${key}.json`)
  let rawAttempt: unknown
  try { rawAttempt = readJson(attemptFile) }
  catch {
    writeJob(cwd, record, 'failed')
    return invalidAttemptEvidence(cwd, transport)
  }
  const parsedAttempt = attemptStateSchema.safeParse(rawAttempt)
  const requestToken = requested ? validationRequestToken(cwd, record) : null
  if (fs.existsSync(attemptFile) && (!parsedAttempt.success || parsedAttempt.data.key !== key)) {
    writeJob(cwd, record, 'failed')
    return invalidAttemptEvidence(cwd, transport)
  }
  let attempt: ValidationAttemptState = parsedAttempt.success && !(requestToken && requestToken !== parsedAttempt.data.requestToken)
    ? parsedAttempt.data : { version: 1, key, requestToken, attempts: 0, status: 'running', nextAttemptAt: 0, evidence: null }
  if (attempt.evidence && (attempt.evidence.projectId !== record.projectId || attempt.evidence.sha !== record.commitSha
    || attempt.evidence.baseSha !== transport.baseSha || attempt.evidence.environment !== record.environment || attempt.evidence.fingerprint !== transport.fingerprint)) {
    writeJob(cwd, record, 'failed')
    return invalidAttemptEvidence(cwd, transport)
  }
  const controller = new AbortController()
  const abort = (): void => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) abort()
  let superseded = false
  const poll = setInterval(() => {
    try {
      const newest = defaultCheckpointDeps(cwd).readQueue().at(-1)
      const saving = readJson(path.join(cwd, TURN_DIR, 'validation-request.json')) !== null
      if (!requested && (!automaticValidation(cwd) || (newest && newest.checkpointId !== record.checkpointId && Date.parse(newest.createdAt) >= Date.parse(record.createdAt)) || (record.draft && saving))) {
        superseded = true; controller.abort()
      }
    } catch { controller.abort() }
  }, 250)
  writeJob(cwd, record, 'running')
  try {
    // Persist before launch: a daemon/process crash spends that attempt too.
    // A fresh explicit request gets a new token, not an implicit infinite retry.
    if (attempt.status === 'completed' && attempt.evidence) {
      const evidence = { ...attempt.evidence, checkpointId: record.checkpointId,
        ...(attempt.evidence.checkpointId !== record.checkpointId ? { id: crypto.randomUUID() } : {}) }
      writeJson(path.join(cwd, VALIDATION_DIR, `${evidence.id}.json`), evidence)
      writeJob(cwd, record, evidence.status)
      return evidence
    }
    while (attempt.attempts < limits.max_attempts) {
      await waitForRetry(Math.min(limits.retry_backoff_ms * 2, Math.max(0, attempt.nextAttemptAt - Date.now())), controller.signal)
      attempt = { ...attempt, status: 'running', attempts: attempt.attempts + 1,
        nextAttemptAt: Date.now() + limits.retry_backoff_ms }
      writeJson(attemptFile, attempt)
      writeJob(cwd, record, 'running', { attempts: attempt.attempts })
      const evidence = await validateCheckpoint(cwd, record, controller.signal)
      const retry = retryableValidation(evidence) && attempt.attempts < limits.max_attempts
      attempt = { ...attempt, evidence, status: retry ? 'waiting' : 'completed',
        nextAttemptAt: retry ? Date.now() + limits.retry_backoff_ms * attempt.attempts : 0 }
      writeJson(attemptFile, attempt)
      if (retry) {
        writeJob(cwd, record, 'running', { attempts: attempt.attempts, nextAttemptAt: attempt.nextAttemptAt })
        continue
      }
      writeJob(cwd, record, evidence.status)
      if (evidence.status !== 'failed') writeJson(cacheFile, evidence)
      return evidence
    }
    const evidence = exhaustedValidation(cwd, record, transport, attempt.evidence)
    writeJson(attemptFile, { ...attempt, status: 'exhausted', evidence })
    writeJob(cwd, record, 'failed', { attempts: attempt.attempts })
    return evidence
  } catch (error) {
    if (!(error instanceof WorkerAbortedError)) throw error
    writeJob(cwd, record, superseded ? 'superseded' : 'cancelled')
    return transport
  } finally { clearInterval(poll); signal?.removeEventListener('abort', abort) }
}

/** One owner across daemon restarts. An interrupted running check is revalidated. */
export async function drainLocalValidation(cwd: string, signal?: AbortSignal): Promise<number> {
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
      return drainLocalValidation(cwd, signal)
    }
  }
  try {
    const deps = defaultCheckpointDeps(cwd)
    const queue = deps.readQueue()
    const eligible = queue.filter((item) => item.environment !== undefined && item.environment !== 'unknown' &&
      (item.validationStatus === 'pending' || item.validationStatus === 'running' || hasValidationRequest(cwd, item)))
    const record = eligible.at(-1)
    // Older snapshots remain transport-checked and visible; costly QA prioritizes current work.
    for (const older of eligible.slice(0, -1)) {
      const transport = scanCheckpointForUpload(cwd, older)
      deps.appendQueue({ ...older, validationStatus: transport.status, validationId: transport.id, validatedSha: transport.sha })
      writeJob(cwd, older, 'superseded')
    }
    if (!record) return automaticValidation(cwd) ? await validateDraft(cwd, signal) : 0
    const requestToken = validationRequestToken(cwd, record)
    const requested = requestToken !== null
    if (!requested && automaticValidation(cwd) && Date.parse(record.createdAt) + readEnginePolicy(cwd).validation.debounce_ms > Date.now()) return 0
    deps.appendQueue({ ...record, validationStatus: 'running' })
    const transport = scanCheckpointForUpload(cwd, record)
    let evidence = transport
    if (transport.status !== 'failed' && (requested || automaticValidation(cwd))) {
      evidence = await executeScheduledValidation(cwd, record, transport, signal, requested)
    }
    const sameRequest = validationRequestToken(cwd, record) === requestToken
    if (requested && sameRequest && !signal?.aborted) fs.rmSync(validationRequestFile(cwd, record), { force: true })
    const latest = deps.readQueue().find((item) => item.checkpointId === record.checkpointId) ?? record
    deps.appendQueue({ ...latest, validationStatus: signal?.aborted || !sameRequest ? 'pending' : evidence.status, validationId: evidence.id, validatedSha: evidence.sha })
    return 1
  } finally { fs.unlinkSync(lock) }
}

/** Debounced saves are validated without publishing intermediate work or touching HEAD. */
async function validateDraft(cwd: string, signal?: AbortSignal): Promise<number> {
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
  const transport = scanCheckpointForUpload(cwd, draft)
  const evidence = transport.status === 'failed' ? transport : await executeScheduledValidation(cwd, draft, transport, signal)
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
  const controller = new AbortController()
  const heartbeat = (): void => writeJson(path.join(cwd, VALIDATION_DIR, 'worker-health.json'), { protocolVersion: 1, pid: process.pid, checkedAt: Date.now() })
  heartbeat()
  const heartbeatTimer = setInterval(heartbeat, 5000)
  let timer: ReturnType<typeof setTimeout> | undefined
  const tick = async (): Promise<void> => {
    try { await drainLocalValidation(cwd, controller.signal)
      if (!stopped) { const { drainAutoHeal } = await import('./engine-repair'); await drainAutoHeal(cwd, controller.signal) }
    }
    catch (error) { console.error('[validation]', sanitizeDiagnostic(error instanceof Error ? error.message : String(error))) }
    if (!stopped) timer = setTimeout(() => { void tick() }, 1200)
  }
  void tick()
  return () => { stopped = true; controller.abort(); clearInterval(heartbeatTimer); if (timer) clearTimeout(timer) }
}
