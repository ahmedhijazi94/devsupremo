import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { DatabaseOperation } from './database'

const directory = (cwd: string): string => path.join(cwd, '.supremo/database-queue')
const operations: readonly string[] = ['status', 'migrate', 'anonymous-auth']
const timeoutMs = 90_000
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function writeAtomic(file: string, value: unknown): void {
  const temporary = `${file}.${randomUUID()}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' })
  fs.renameSync(temporary, file)
}

function readRequest(file: string): unknown {
  // Não seguir symlinks nem bloquear ao abrir um FIFO. fstat e read usam o
  // mesmo descritor: renomear/trocar o caminho não troca o arquivo inspecionado.
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || stat.size > 1024) throw new Error('Pedido de banco inválido.')
    // Limite também na leitura: o inode pode crescer depois do fstat.
    const buffer = Buffer.alloc(1025)
    let length = 0
    while (length < buffer.length) {
      const count = fs.readSync(fd, buffer, length, buffer.length - length, length)
      if (count === 0) break
      length += count
    }
    if (length > 1024) throw new Error('Pedido de banco inválido.')
    return JSON.parse(buffer.toString('utf8', 0, length)) as unknown
  } finally {
    fs.closeSync(fd)
  }
}

// A fila transporta apenas operações conhecidas. Não contém credenciais, URLs,
// refs, comandos de shell ou caminhos escolhidos pelo solicitante.
export async function requestDatabase(cwd: string, operation: DatabaseOperation): Promise<unknown> {
  const dir = directory(cwd)
  let heartbeat = 0
  try { heartbeat = Number(fs.readFileSync(path.join(dir, 'heartbeat'), 'utf8')) } catch { /* daemon antigo/ausente */ }
  if (!Number.isFinite(heartbeat) || heartbeat <= 0 || Date.now() - heartbeat > 5000 || heartbeat > Date.now() + 5000) {
    throw new Error('Canal de banco do daemon indisponível. Atualize a CLI e reinicie somente o daemon no terminal autorizado; preserve o preview. Não é necessário refazer o bootstrap.')
  }
  const id = randomUUID()
  const request = path.join(dir, `${id}.request.json`)
  const response = path.join(dir, `${id}.response.json`)
  const expiresAt = Date.now() + timeoutMs
  writeAtomic(request, { operation, expiresAt })
  try {
    while (Date.now() < expiresAt) {
      if (fs.existsSync(response)) {
        const result = JSON.parse(fs.readFileSync(response, 'utf8')) as { ok: boolean; data?: unknown; error?: string }
        if (!result.ok) throw new Error(result.error ?? 'Operação de banco recusada.')
        return result.data
      }
      await pause(100)
    }
    throw new Error('O daemon não confirmou a operação de banco a tempo. Consulte db status e repita migrate para verificar o histórico idempotente; não presuma sucesso.')
  } finally {
    fs.rmSync(request, { force: true })
    fs.rmSync(response, { force: true })
  }
}

export async function drainDatabaseRequests(
  cwd: string,
  execute: (operation: DatabaseOperation) => Promise<unknown>,
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
      const body = readRequest(request)
      if (!body || typeof body !== 'object') throw new Error('Pedido de banco inválido.')
      const input = body as Record<string, unknown>
      if (Object.keys(input).sort().join(',') !== 'expiresAt,operation' ||
        typeof input.operation !== 'string' || !operations.includes(input.operation) ||
        typeof input.expiresAt !== 'number' || !Number.isFinite(input.expiresAt)) {
        throw new Error('Pedido de banco inválido.')
      }
      expiresAt = input.expiresAt
      if (expiresAt <= Date.now() || expiresAt > Date.now() + timeoutMs) {
        fs.rmSync(request, { force: true })
        continue
      }
      result = { ok: true, data: await execute(input.operation as DatabaseOperation) }
    } catch (error) {
      result = { ok: false, error: error instanceof Error ? error.message : 'Falha no canal de banco.' }
    }
    // Cliente que desistiu não recebe resposta tardia. Escritas já enviadas
    // permanecem reconciliáveis pelo histórico transacional no servidor.
    if (fs.existsSync(request) && (!expiresAt || expiresAt > Date.now())) writeAtomic(response, result)
  }
}

export function startDatabaseWorker(cwd: string, execute: (operation: DatabaseOperation) => Promise<unknown>): () => void {
  const dir = directory(cwd)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  let running = false
  const tick = (): void => {
    writeAtomic(path.join(dir, 'heartbeat'), Date.now())
    if (running) return
    running = true
    void drainDatabaseRequests(cwd, execute).catch(() => {
      process.stderr.write('[daemon] Falha ao processar a fila local de banco.\n')
    }).finally(() => { running = false })
  }
  tick()
  const timer = setInterval(tick, 250)
  return () => { clearInterval(timer); fs.rmSync(path.join(dir, 'heartbeat'), { force: true }) }
}
