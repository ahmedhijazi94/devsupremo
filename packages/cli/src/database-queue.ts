import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { databaseOperationSchema, parseDatabaseOptions, type DatabaseOperation, type DatabaseOptions } from './database-request'
import { sanitizeDiagnostic } from '../../../src/lib/checkpoint/feedback'
import { z } from 'zod'
import { drainDurableOperations, enqueueDatabaseOperation, waitForDatabaseOperation } from './durable-operations'

const directory = (cwd: string): string => path.join(cwd, '.supremo/database-queue')
const maxRequestBytes = 32 * 1024
const maxDeleteRequestBytes = 600 * 1024
const timeoutMs = 90_000
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function timeoutMessage(operation: DatabaseOperation, options: DatabaseOptions): string {
  if (operation.startsWith('data-delete-')) {
    return operation === 'data-delete-apply'
      ? 'O daemon não confirmou a exclusão a tempo; ela pode ter concluído. Não repita delete-apply. Consulte os registros com db query e gere um novo delete-plan somente após conferir o resultado.'
      : 'O daemon não confirmou o plano a tempo. Nenhum pedido de exclusão foi enviado; solicite novamente data delete-plan para inspecionar os registros.'
  }
  if (operation.startsWith('functions-')) {
    const check = operation.startsWith('functions-hook-') ? 'functions hook-status'
      : options.slug ? `functions status ${options.slug}` : 'functions list'
    return `O daemon não confirmou a operação de funções a tempo. Consulte ${check} antes de repetir: a operação pode ter concluído no provedor. Não presuma sucesso.`
  }
  if (!operation.startsWith('secrets-')) return 'O daemon não confirmou a operação de banco a tempo. Consulte db status e repita migrate para verificar o histórico idempotente; não presuma sucesso.'
  const check = operation === 'secrets-credentials' || operation === 'secrets-revoke-credential' ? 'integrations credentials'
    : options.requestId && operation !== 'secrets-dismiss' ? `secrets status --request-id ${options.requestId}` : 'secrets status'
  return `O daemon não confirmou a operação de integração a tempo. Consulte ${check} antes de tentar novamente: a operação pode ter concluído no servidor. Não repita o envio sem conferir o resultado e não presuma sucesso.`
}

function writeAtomic(file: string, value: unknown): void {
  const temporary = `${file}.${randomUUID()}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' })
  fs.renameSync(temporary, file)
}

function readRequest(file: string, maximumBytes = maxDeleteRequestBytes): unknown {
  // Não seguir symlinks nem bloquear ao abrir um FIFO. fstat e read usam o
  // mesmo descritor: renomear/trocar o caminho não troca o arquivo inspecionado.
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || stat.size > maximumBytes) throw new Error('Pedido de banco inválido.')
    // Limite também na leitura: o inode pode crescer depois do fstat.
    const buffer = Buffer.alloc(maximumBytes + 1)
    let length = 0
    while (length < buffer.length) {
      const count = fs.readSync(fd, buffer, length, buffer.length - length, length)
      if (count === 0) break
      length += count
    }
    if (length > maximumBytes) throw new Error('Pedido de banco inválido.')
    const parsed = JSON.parse(buffer.toString('utf8', 0, length)) as unknown
    if (maximumBytes === maxDeleteRequestBytes && length > maxRequestBytes) {
      const operation = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>).operation : undefined
      if (operation !== 'data-delete-apply' && (operation !== 'data-delete-plan' || length > 256 * 1024)) throw new Error('Pedido de banco inválido.')
    }
    if (length > 1024 && parsed && typeof parsed === 'object' && ['status', 'migrate', 'anonymous-auth'].includes(String((parsed as Record<string, unknown>).operation))) throw new Error('Pedido de banco inválido.')
    return parsed
  } finally {
    fs.closeSync(fd)
  }
}

// A fila transporta somente operações e opções tipadas. SQL de leitura é dado
// não confiável: o servidor aplica sua própria restrição, escopo e limites.
// Credenciais, URLs, refs e comandos shell nunca são aceitos neste canal.
export async function requestDatabase(cwd: string, operation: DatabaseOperation, options: DatabaseOptions = {}): Promise<unknown> {
  const selected = databaseOperationSchema.parse(operation)
  const checkedOptions = parseDatabaseOptions(selected, options)
  const dir = directory(cwd)
  let heartbeat = 0
  try { heartbeat = Number(fs.readFileSync(path.join(dir, 'heartbeat'), 'utf8')) } catch { /* daemon antigo/ausente */ }
  if (!Number.isFinite(heartbeat) || heartbeat <= 0 || Date.now() - heartbeat > 5000 || heartbeat > Date.now() + 5000) {
    throw new Error('Canal de banco do daemon indisponível. Atualize a CLI e reinicie somente o daemon no terminal autorizado; preserve o preview. Não é necessário refazer o bootstrap.')
  }
  const capability = path.join(dir, 'capabilities.json')
  if (fs.existsSync(capability)) {
    const worker = z.object({ protocolVersion: z.literal(2), pid: z.number().int().positive() }).strict().parse(readRequest(capability, 1024))
    try { process.kill(worker.pid, 0) }
    catch { throw new Error('Executor durável indisponível; retome o daemon antes de enviar a operação.') }
    return waitForDatabaseOperation(cwd, enqueueDatabaseOperation(cwd, selected, checkedOptions))
  }
  // Old workers retain the legacy wire contract until an explicit runtime update.
  const id = randomUUID()
  const request = path.join(dir, `${id}.request.json`)
  const response = path.join(dir, `${id}.response.json`)
  const expiresAt = Date.now() + timeoutMs
  writeAtomic(request, { operation: selected, expiresAt, ...(Object.keys(checkedOptions).length ? { options: checkedOptions } : {}) })
  try {
    while (Date.now() < expiresAt) {
      if (fs.existsSync(response)) {
        const result = z.object({ ok: z.boolean(), data: z.unknown().optional(), error: z.string().max(16_000).optional() }).strict().parse(readRequest(response, 2 * 1024 * 1024))
        if (!result.ok) throw new Error(result.error ?? 'Operação de banco recusada.')
        return result.data
      }
      await pause(100)
    }
    throw new Error(timeoutMessage(selected, checkedOptions))
  } finally {
    fs.rmSync(request, { force: true })
    fs.rmSync(response, { force: true })
  }
}

export async function drainDatabaseRequests(
  cwd: string,
  execute: (operation: DatabaseOperation, options?: DatabaseOptions) => Promise<unknown>,
): Promise<void> {
  const dir = directory(cwd)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  for (const name of fs.readdirSync(dir)) {
    if (!/^[0-9a-f-]{36}\.request\.json$/.test(name)) continue
    const request = path.join(dir, name)
    const response = request.replace(/\.request\.json$/, '.response.json')
    if (fs.existsSync(response)) continue
    let result: { ok: boolean; data?: unknown; error?: string }
    let expiresAt = 0
    try {
      const input = z.object({ operation: databaseOperationSchema, expiresAt: z.number().finite(), options: z.unknown().optional() }).strict().parse(readRequest(request))
      const options = parseDatabaseOptions(input.operation, input.options ?? {})
      expiresAt = input.expiresAt
      if (expiresAt <= Date.now() || expiresAt > Date.now() + timeoutMs) {
        fs.rmSync(request, { force: true })
        continue
      }
      result = { ok: true, data: Object.keys(options).length ? await execute(input.operation, options) : await execute(input.operation) }
    } catch (error) {
      result = { ok: false, error: sanitizeDiagnostic(error instanceof Error ? error.message : 'Falha no canal de banco.') }
    }
    // Cliente que desistiu não recebe resposta tardia. Escritas já enviadas
    // permanecem reconciliáveis pelo histórico transacional no servidor.
    if (fs.existsSync(request) && (!expiresAt || expiresAt > Date.now())) writeAtomic(response, result)
  }
}

export function startDatabaseWorker(cwd: string, execute: (operation: DatabaseOperation, options?: DatabaseOptions) => Promise<unknown>): () => void {
  const dir = directory(cwd)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeAtomic(path.join(dir, 'capabilities.json'), { protocolVersion: 2, pid: process.pid })
  let running = false
  const tick = (): void => {
    writeAtomic(path.join(dir, 'heartbeat'), Date.now())
    if (running) return
    running = true
    void drainDatabaseRequests(cwd, execute).then(() => drainDurableOperations(cwd, execute)).catch(() => {
      process.stderr.write('[daemon] Falha ao processar a fila local de banco.\n')
    }).finally(() => { running = false })
  }
  tick()
  const timer = setInterval(tick, 250)
  return () => { clearInterval(timer); fs.rmSync(path.join(dir, 'heartbeat'), { force: true }); fs.rmSync(path.join(dir, 'capabilities.json'), { force: true }) }
}
