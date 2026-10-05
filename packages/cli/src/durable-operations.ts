import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { sanitizeDiagnostic } from '../../../src/lib/checkpoint/feedback'
import { databaseOperationSchema, parseDatabaseOptions, type DatabaseOperation, type DatabaseOptions } from './database-request'
import { readStableFile } from './stable-file'
import { measureRuntime } from './runtime-metrics'
import { deviceIssuer } from './device-identity'
import { isAuthRead } from '../../../src/lib/database-admin/options'
import { isFunctionRead } from '../../../src/lib/edge-functions/contract'

const MAX_AGE_MS = 24 * 60 * 60 * 1000
export const INTERACTIVE_WAIT_MS = 5000
const operationSchema = z.object({
  version: z.literal(1), id: z.string().uuid(), operation: databaseOperationSchema,
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'uncertain', 'expired', 'needs_authorization']),
  createdAt: z.number().finite(), expiresAt: z.number().finite(), updatedAt: z.number().finite(),
  identity: z.object({ projectId: z.string().uuid(), issuer: z.string() }).nullable(),
  options: z.unknown(), owner: z.object({ pid: z.number().int().positive(), token: z.string().uuid() }).optional(),
  result: z.unknown().optional(), error: z.string().max(16000).optional(),
  authorizationOperationId: z.string().uuid().optional(), resumedAt: z.number().finite().optional(),
  authorizationInputDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict()
export type DurableOperation = z.infer<typeof operationSchema>
export type ExecuteDatabase = (operation: DatabaseOperation, options?: DatabaseOptions) => Promise<unknown>
export { isOperationReceipt } from './operation-receipt'
const root = (cwd: string): string => path.join(cwd, '.supremo/database-queue/operations')
const filename = (cwd: string, id: string): string => path.join(root(cwd), `${z.string().uuid().parse(id)}.json`)
function ensureDirectory(cwd: string): void {
  for (const relative of ['.supremo', '.supremo/database-queue', '.supremo/database-queue/operations']) {
    const file = path.join(cwd, relative), stat = fs.lstatSync(file, { throwIfNoEntry: false })
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error('Diretório de operações inválido.')
    if (!stat) fs.mkdirSync(file, { mode: 0o700 })
  }
}
function write(cwd: string, operation: DurableOperation): void {
  ensureDirectory(cwd)
  const file = filename(cwd, operation.id), temporary = `${file}.${randomUUID()}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(operation), { mode: 0o600, flag: 'wx' })
  fs.renameSync(temporary, file)
}
export function readDurableOperation(cwd: string, id: string): DurableOperation {
  for (let attempt = 0; ; attempt++) {
    try {
      const operation = operationSchema.parse(JSON.parse(readStableFile(filename(cwd, id), 3 * 1024 * 1024, cwd).content))
      if (operation.id !== id) throw new Error('Identidade da operação diverge do recibo.')
      return operation
    } catch (error) {
      // Atomic receipt replacement is a normal worker transition. Retry the
      // read only, boundedly; never retry a dispatched database operation.
      if (attempt >= 3 || !(error instanceof Error) || !/Arquivo (?:mudou|foi alterado)/.test(error.message)) throw error
    }
  }
}
export function operationStatus(cwd: string, id: string): Record<string, unknown> {
  const entry = readDurableOperation(cwd, id)
  return { operationId: entry.id, operation: entry.operation, status: entry.status,
    pending: ['queued', 'running'].includes(entry.status), createdAt: entry.createdAt, updatedAt: entry.updatedAt,
    ...(entry.result === undefined ? {} : { result: entry.result }), ...(entry.error ? { error: entry.error } : {}),
    ...(entry.authorizationOperationId ? { authorizationOperationId: entry.authorizationOperationId } : {}),
    nextAction: entry.status === 'needs_authorization' ? `Aprove a operação ${entry.authorizationOperationId} no Supremo e execute supremo operation resume ${entry.id}.`
      : entry.status === 'uncertain' ? 'Confira o efeito no servidor pelo canal de leitura; não repita a mutação sem reconciliação.'
      : ['queued', 'running'].includes(entry.status) ? `supremo operation status ${entry.id}` : null }
}
export function enqueueDatabaseOperation(cwd: string, operation: DatabaseOperation, options: DatabaseOptions): string {
  const selected = databaseOperationSchema.parse(operation), checked = parseDatabaseOptions(selected, options)
  const id = randomUUID(), now = Date.now()
  write(cwd, { version: 1, id, operation: selected, options: checked, identity: projectIdentity(cwd), status: 'queued', createdAt: now, updatedAt: now, expiresAt: now + MAX_AGE_MS })
  return id
}
function projectIdentity(cwd: string): DurableOperation['identity'] {
  const file = path.join(cwd, '.supremo/project.json')
  if (!fs.existsSync(file)) return null
  const parsed = z.object({ projectId: z.string().uuid(), supremoUrl: z.string() }).parse(JSON.parse(readStableFile(file, 64 * 1024, cwd).content))
  return { projectId: parsed.projectId, issuer: deviceIssuer(parsed.supremoUrl) }
}
function processDead(pid: number): boolean {
  try { process.kill(pid, 0); return false }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' }
}
const readOnly = new Set(['status', 'inspect', 'query', 'logs', 'report', 'cron-list', 'cron-history',
  'secrets-status', 'secrets-credentials', 'data-plan', 'data-delete-plan', 'backend-catalog', 'backend-policy', 'backend-operation-status', 'backend-integration-status', 'backend-approval-status', 'backend-usage'])
function isReadOperation(operation: DatabaseOperation, options: DatabaseOptions): boolean {
  const nested = options.options && 'operation' in options.options ? options.options.operation : undefined
  return readOnly.has(operation) || isAuthRead(operation) || isFunctionRead(operation) ||
    operation === 'backend-storage' && nested !== undefined && ['storage-buckets', 'storage-list', 'storage-download'].includes(nested) ||
    operation === 'backend-integration' && nested === 'github-repository'
}
function providerOperationId(operation: DatabaseOperation, options: DatabaseOptions): string | undefined {
  return options.operationId ?? (operation === 'secrets-apply' ? options.requestId : undefined) ?? (options.options && 'operationId' in options.options ? options.options.operationId : undefined)
}
const inputDigest = (operation: DatabaseOperation, options: DatabaseOptions): string => createHash('sha256').update(JSON.stringify({ operation, options })).digest('hex')

/** A successful HTTP exchange may carry an unfinished or uncertain effect.
 * Inspect only mutation envelopes, never arbitrary rows returned by a read. */
function effectOutcome(operation: DatabaseOperation, options: DatabaseOptions, result: unknown): { status: 'succeeded' | 'failed' | 'uncertain'; error?: string } {
  if (isReadOperation(operation, options) && operation !== 'backend-integration') return { status: 'succeeded' }
  const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
  const envelope = object(result), data = object(envelope?.data)
  let state: string | undefined
  if (operation === 'backend-integration') {
    const receipt = z.object({ operationId: z.string().uuid(), status: z.enum(['running', 'verifying', 'completed', 'outcome_unknown', 'failed']), effectVerified: z.boolean() }).safeParse(data)
    if (receipt.success && receipt.data.operationId === providerOperationId(operation, options)) {
      state = receipt.data.status === 'completed' && receipt.data.effectVerified ? 'succeeded' : receipt.data.status === 'failed' ? 'failed' : 'uncertain'
    } else state = 'uncertain'
  } else {
    const receipts = [envelope?.receipt, envelope?.operationReceipt, data?.receipt, data?.operationReceipt].filter(value => value !== undefined)
    if (!receipts.length) return { status: 'succeeded' } // Older read/mutation contracts return their result directly.
    const states = receipts.map(value => {
      const parsed = z.object({ id: z.string().uuid(), state: z.enum(['queued', 'running', 'verifying', 'succeeded', 'failed', 'uncertain', 'cancelled']) }).safeParse(value)
      const expectedId = providerOperationId(operation, options)
      return parsed.success && (!expectedId || parsed.data.id === expectedId) ? parsed.data.state : 'uncertain'
    })
    state = states.every(value => value === 'succeeded') ? 'succeeded'
      : states.every(value => value === 'failed' || value === 'cancelled') ? 'failed' : 'uncertain'
  }
  return state === 'succeeded' ? { status: 'succeeded' } : state === 'failed'
    ? { status: 'failed', error: 'O recibo do servidor confirmou falha ou cancelamento. Consulte o resultado antes de preparar outra operação.' }
    : { status: 'uncertain', error: 'O servidor ainda não confirmou o efeito. Consulte o recibo remoto; nenhuma repetição automática foi autorizada.' }
}
/** Only an explicit refusal before dispatch can be resumed. The provider's ID
 * and original payload survive owner approval; uncertain effects cannot enter here. */
export function resumeDatabaseOperation(cwd: string, id: string): Record<string, unknown> {
  ensureDirectory(cwd)
  const lease = path.join(root(cwd), `${z.string().uuid().parse(id)}.lease`), staging = `${lease}.${randomUUID()}.tmp`
  const token = randomUUID()
  fs.writeFileSync(staging, JSON.stringify({ pid: process.pid, token }), { flag: 'wx', mode: 0o600 })
  let held = false
  try {
    fs.linkSync(staging, lease); held = true
    const entry = readDurableOperation(cwd, id), options = parseDatabaseOptions(entry.operation, entry.options)
    if (entry.status !== 'needs_authorization' || !entry.authorizationOperationId || inputDigest(entry.operation, options) !== entry.authorizationInputDigest ||
      providerOperationId(entry.operation, options) !== undefined && providerOperationId(entry.operation, options) !== entry.authorizationOperationId) {
      throw new Error('Somente recusa de autorização anterior ao envio pode ser retomada. Operações incertas nunca são repetidas.')
    }
    if (JSON.stringify(entry.identity) !== JSON.stringify(projectIdentity(cwd))) throw new Error('Projeto ou origem mudou; recibo preservado.')
    const next = { ...entry, status: 'queued' as const, resumedAt: Date.now(), updatedAt: Date.now(), expiresAt: Date.now() + MAX_AGE_MS }
    delete next.error; delete next.owner
    write(cwd, next)
    return operationStatus(cwd, id)
  } finally { fs.rmSync(staging, { force: true }); if (held) fs.rmSync(lease, { force: true }) }
}

/** A dead owner is never evidence that its external mutation did not happen. */
export async function drainDurableOperations(cwd: string, execute: ExecuteDatabase): Promise<void> {
  ensureDirectory(cwd)
  for (const name of fs.readdirSync(root(cwd)).filter(name => /^[a-f0-9-]{36}\.json$/.test(name))) {
    const id = name.slice(0, -5)
    let entry: DurableOperation
    try { entry = readDurableOperation(cwd, id) }
    catch { process.stderr.write('[operations] Recibo inválido preservado; outras operações podem continuar.\n'); continue }
    if (entry.status === 'running') {
      if (!entry.owner || !processDead(entry.owner.pid)) continue
      write(cwd, { ...entry, status: 'uncertain', updatedAt: Date.now(), error: 'Executor interrompido após iniciar a operação. Resultado deve ser reconciliado; nenhuma repetição automática foi enviada.' })
      continue
    }
    if (entry.status !== 'queued') continue
    const lease = path.join(root(cwd), `${id}.lease`)
    // Publish a complete owner atomically; an ownerless interrupted staging file
    // cannot make a public lease that another worker steals.
    const token = randomUUID(), owner = { pid: process.pid, token }
    const staging = `${lease}.${token}.tmp`
    fs.writeFileSync(staging, JSON.stringify(owner), { flag: 'wx', mode: 0o600 })
    try {
      try { fs.linkSync(staging, lease) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        let prior: { pid: number; token: string }
        try { prior = z.object({ pid: z.number().int().positive(), token: z.string().uuid() }).parse(JSON.parse(readStableFile(lease, 1024, cwd).content)) }
        catch {
          write(cwd, { ...entry, status: 'uncertain', updatedAt: Date.now(), error: 'Posse anterior não verificável; nenhuma operação repetida. Recibo e lease preservados para reconciliação.' })
          continue
        }
        if (processDead(prior.pid)) {
          // Preserve uncertainty even if the old worker crashed before publishing
          // its running receipt. No external operation is retried automatically.
          write(cwd, { ...entry, status: 'uncertain', updatedAt: Date.now(), error: 'Executor anterior interrompido; reconciliação necessária.' })
        }
        continue
      }
      entry = readDurableOperation(cwd, id)
      if (entry.status !== 'queued') continue
      if (entry.expiresAt <= Date.now() || entry.expiresAt - (entry.resumedAt ?? entry.createdAt) > MAX_AGE_MS || (entry.resumedAt ?? entry.createdAt) > Date.now() + 5000) {
        write(cwd, { ...entry, status: 'expired', updatedAt: Date.now() }); continue
      }
      let options: DatabaseOptions, identity: DurableOperation['identity']
      try { options = parseDatabaseOptions(entry.operation, entry.options); identity = projectIdentity(cwd) }
      catch {
        write(cwd, { ...entry, status: 'failed', updatedAt: Date.now(), error: 'Contrato ou identidade do pedido inválido; nenhuma operação executada.' }); continue
      }
      if (JSON.stringify(entry.identity) !== JSON.stringify(identity)) {
        write(cwd, { ...entry, status: 'failed', updatedAt: Date.now(), error: 'Projeto ou origem mudou desde o pedido; nenhuma operação foi executada.' }); continue
      }
      entry = { ...entry, owner, status: 'running', updatedAt: Date.now() }
      write(cwd, entry)
      let completed: DurableOperation
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined
      try {
        const result = await measureRuntime(cwd, 'database', () => Promise.race([
          Object.keys(options).length ? execute(entry.operation, options) : execute(entry.operation),
          new Promise<never>((_resolve, reject) => { deadlineTimer = setTimeout(() => reject(new Error('Executor não confirmou o resultado em 120 segundos; reconciliação necessária.')), 120_000) }),
        ]), id)
        completed = { ...entry, ...effectOutcome(entry.operation, options, result), result, updatedAt: Date.now() }
      } catch (error) {
        const definitive = error instanceof Error && 'definitive' in error && error.definitive === true
        const authorizationId = error instanceof Error && 'code' in error && error.code === 'operation_approval_required' && 'operationId' in error
          ? z.string().uuid().safeParse(error.operationId) : null
        const knownId = providerOperationId(entry.operation, options)
        const awaitingOwner = authorizationId?.success && (knownId !== undefined ? authorizationId.data === knownId : ['data-apply', 'data-delete-apply'].includes(entry.operation))
        completed = { ...entry, status: awaitingOwner ? 'needs_authorization' : isReadOperation(entry.operation, options) || definitive ? 'failed' : 'uncertain', updatedAt: Date.now(),
          ...(awaitingOwner ? { authorizationOperationId: authorizationId.data, authorizationInputDigest: inputDigest(entry.operation, options) } : {}),
          error: sanitizeDiagnostic(error instanceof Error ? error.message : 'Falha na operação de banco.') }
      } finally { if (deadlineTimer !== undefined) clearTimeout(deadlineTimer) }
      if (readDurableOperation(cwd, id).owner?.token === token) write(cwd, completed)
    } finally {
      fs.rmSync(staging, { force: true })
      if (fs.existsSync(lease)) {
        try {
          const held = JSON.parse(readStableFile(lease, 1024, cwd).content) as { token?: string }
          if (held.token === token) fs.rmSync(lease)
        } catch { process.stderr.write('[operations] Lease não verificável preservado para reconciliação.\n') }
      }
    }
  }
}

export async function waitForDatabaseOperation(cwd: string, id: string, waitMs = INTERACTIVE_WAIT_MS): Promise<unknown> {
  const deadline = Date.now() + Math.min(INTERACTIVE_WAIT_MS, Math.max(0, waitMs))
  for (;;) {
    const entry = readDurableOperation(cwd, id)
    if (entry.status === 'succeeded') return entry.result
    if (entry.status === 'failed' || entry.status === 'expired') throw new Error(`${entry.error ?? 'Operação expirada.'} Consulte supremo operation status ${id}.`)
    if (entry.status === 'uncertain' || entry.status === 'needs_authorization' || Date.now() >= deadline) return operationStatus(cwd, id)
    await new Promise<void>(resolve => setTimeout(resolve, 100))
  }
}
