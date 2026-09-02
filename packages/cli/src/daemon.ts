import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import {
  parseQueue,
  serializeQueue,
  CHECKPOINT_DIR,
  NOTIFY_FILE,
  QUEUE_FILE,
  type CheckpointRecord,
  type PushStatus,
} from './checkpoint'
import {
  buildChangeset,
  computeChangesetSha256,
  defaultCommitReader,
  type Changeset,
  type CommitReader,
} from './changeset'
import { resolveKeychain } from './keychain'

/**
 * SUPREMO CHECKPOINT DAEMON (endurecido) — envia os checkpoints em BACKGROUND.
 *
 * NENHUMA credencial GitHub existe nesta máquina. O agente nunca faz `git push`; o
 * daemon nunca recebe installation token. O daemon monta um CHANGESET
 * content-addressed do commit do checkpoint (só leitura do git local) e o ENVIA ao
 * Control Plane do Supremo, autenticado pelo secret do device. O BACKEND publica
 * na branch de integração (derivada server-side) e garante a PR. O daemon NÃO
 * escolhe branch, NÃO empurra e NÃO espera CI.
 *
 * A decisão de fila/backoff é pura/testada; o git (só leitura) e o HTTP são
 * injetados para o núcleo ser testável sem rede nem repo real.
 */

// ── Estado da fila (puro) ────────────────────────────────────────────────────

const RETRIABLE: ReadonlySet<PushStatus> = new Set<PushStatus>([
  'local',
  'upload_pending',
  'publishing',
])

/** Próximo checkpoint a processar, PRESERVANDO A ORDEM (A antes de B). */
export function selectNextPending(
  queue: readonly CheckpointRecord[],
): CheckpointRecord | null {
  for (const r of queue) if (RETRIABLE.has(r.pushStatus)) return r
  return null
}

/** Backoff exponencial com teto (retry offline/conflito). */
export function backoffDelayMs(attempts: number, baseMs = 2000, maxMs = 60000): number {
  const n = Math.max(0, attempts)
  return Math.min(maxMs, baseMs * 2 ** n)
}

// ── Transições puras de estado ───────────────────────────────────────────────

export function withStatus(
  record: CheckpointRecord,
  status: PushStatus,
  patch: Partial<CheckpointRecord> = {},
): CheckpointRecord {
  return { ...record, pushStatus: status, ...patch }
}

export function upsertQueue(
  queue: readonly CheckpointRecord[],
  record: CheckpointRecord,
): CheckpointRecord[] {
  return queue.map((r) => (r.checkpointId === record.checkpointId ? record : r))
}

// ── I/O injetável ────────────────────────────────────────────────────────────

export class NetworkError extends Error {}
export class AuthError extends Error {}
export class ConflictError extends Error {}

export interface PublishInput {
  deviceSecret: string
  projectId: string
  changeset: Changeset
  changesetSha256: string
  riskLevel: CheckpointRecord['riskLevel']
  summary: string
  migrations: string[]
}

export interface DaemonHttp {
  /**
   * POST /api/checkpoint/publish. Envia o CHANGESET; recebe só {prNumber}. NUNCA
   * recebe token. Lança NetworkError/AuthError/ConflictError.
   */
  publish(input: PublishInput): Promise<{ prNumber: number }>
}

export interface DaemonContext {
  projectId: string
  getSecret: () => string | null
  http: DaemonHttp
  reader: CommitReader
}

export type ProcessOutcome =
  | { record: CheckpointRecord; result: 'done' }
  | { record: CheckpointRecord; result: 'deferred'; reason: string }
  | { record: CheckpointRecord; result: 'failed'; reason: string }

/**
 * Processa UM checkpoint: monta o changeset (só leitura local) e o ENVIA. Nenhum
 * token, nenhum git push, nenhuma espera de CI. Idempotente (o backend deduplica
 * por checkpoint_id). Offline → upload_pending + retry com backoff.
 */
export async function processCheckpoint(
  record: CheckpointRecord,
  ctx: DaemonContext,
): Promise<ProcessOutcome> {
  const secret = ctx.getSecret()
  if (!secret) {
    return {
      record: withStatus(record, 'push_failed'),
      result: 'failed',
      reason: 'device_not_provisioned',
    }
  }

  const changeset = buildChangeset(record, ctx.reader)
  if (changeset.files.length === 0) {
    return {
      record: withStatus(record, 'push_failed'),
      result: 'failed',
      reason: 'empty_changeset',
    }
  }
  const changesetSha256 = computeChangesetSha256(changeset)

  try {
    const { prNumber } = await ctx.http.publish({
      deviceSecret: secret,
      projectId: ctx.projectId,
      changeset,
      changesetSha256,
      riskLevel: record.riskLevel,
      summary: record.summary,
      migrations: record.migrations,
    })
    return {
      record: withStatus(record, 'published', { prNumber }),
      result: 'done',
    }
  } catch (err) {
    if (err instanceof AuthError) {
      return {
        record: withStatus(record, 'push_failed'),
        result: 'failed',
        reason: 'unauthorized',
      }
    }
    // Rede offline OU conflito (409, corrida/non-ff): vira pending e re-tenta com
    // backoff. O backend re-planeja a branch a cada tentativa. Nada se perde.
    const reason = err instanceof ConflictError ? 'conflict' : 'network'
    return {
      record: withStatus(record, 'upload_pending', { attempts: record.attempts + 1 }),
      result: 'deferred',
      reason,
    }
  }
}

// ── Adapter HTTP real (I/O; coberto por E2E) ─────────────────────────────────

export function defaultDaemonHttp(apiBaseUrl: string): DaemonHttp {
  const base = apiBaseUrl.replace(/\/$/, '')
  return {
    publish: async (input) => {
      let res: Response
      try {
        res = await fetch(`${base}/api/checkpoint/publish`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        })
      } catch {
        throw new NetworkError('offline')
      }
      if (res.status === 401 || res.status === 403) throw new AuthError(`${res.status}`)
      if (res.status === 409) throw new ConflictError('conflict')
      if (!res.ok) throw new NetworkError(`${res.status}`)
      const data = (await res.json().catch(() => ({}))) as { prNumber?: number }
      return { prNumber: data.prNumber ?? 0 }
    },
  }
}

// ── Supervisor: daemon PERSISTENTE (detached), como o preview ─────────────────

export const DAEMON_PID_FILE = `${CHECKPOINT_DIR}/daemon.pid`
export const DAEMON_LOG_FILE = `${CHECKPOINT_DIR}/daemon.log`

interface ProjectConfig {
  projectId: string
  apiBaseUrl: string
}

/** Lê projectId + URL do Supremo de `.supremo/project.json` (não sensível). */
export function readProjectConfig(cwd: string): ProjectConfig | null {
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(cwd, '.supremo/project.json'), 'utf8'),
    ) as { projectId?: string; supremoUrl?: string }
    if (!raw.projectId || !raw.supremoUrl) return null
    return { projectId: raw.projectId, apiBaseUrl: raw.supremoUrl }
  } catch {
    return null
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function readPid(cwd: string): number | null {
  try {
    const pid = Number(fs.readFileSync(path.join(cwd, DAEMON_PID_FILE), 'utf8').trim())
    return Number.isFinite(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

/**
 * Garante UMA instância do daemon rodando (idempotente). Reusa se vivo; senão sobe
 * DESACOPLADO (detached + unref) para sobreviver aos turnos do agente.
 */
export function ensureDaemon(cwd: string): 'reuse' | 'start' {
  const existing = readPid(cwd)
  if (existing && pidAlive(existing)) return 'reuse'

  fs.mkdirSync(path.join(cwd, CHECKPOINT_DIR), { recursive: true })
  const logPath = path.join(cwd, DAEMON_LOG_FILE)
  const out = fs.openSync(logPath, 'a')
  const binPath = process.argv[1] ?? ''
  const child = spawn(process.execPath, [binPath, 'daemon'], {
    cwd,
    detached: true,
    stdio: ['ignore', out, out],
  })
  child.unref()
  if (child.pid) {
    fs.writeFileSync(path.join(cwd, DAEMON_PID_FILE), String(child.pid))
  }
  return 'start'
}

export function daemonStatus(cwd: string): { running: boolean; pid: number | null } {
  const pid = readPid(cwd)
  return { running: pid != null && pidAlive(pid), pid }
}

export function stopDaemon(cwd: string): boolean {
  const pid = readPid(cwd)
  if (pid && pidAlive(pid)) {
    try {
      process.kill(pid)
    } catch {
      /* já morreu */
    }
  }
  try {
    fs.rmSync(path.join(cwd, DAEMON_PID_FILE))
  } catch {
    /* sem pidfile */
  }
  return true
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function minPendingAttempts(queue: readonly CheckpointRecord[]): number | null {
  let min: number | null = null
  for (const r of queue) {
    if (RETRIABLE.has(r.pushStatus)) {
      min = min === null ? r.attempts : Math.min(min, r.attempts)
    }
  }
  return min
}

export interface DaemonConfig {
  projectId: string
  apiBaseUrl: string
  cwd: string
  getSecret: () => string | null
}

/** Lê a fila, processa os pendentes (em ordem) uma vez, persiste a fila. */
export async function drainOnce(config: DaemonConfig): Promise<number> {
  const queuePath = path.join(config.cwd, QUEUE_FILE)
  let queue: CheckpointRecord[]
  try {
    queue = parseQueue(fs.readFileSync(queuePath, 'utf8'))
  } catch {
    return 0
  }
  const ctx: DaemonContext = {
    projectId: config.projectId,
    getSecret: config.getSecret,
    http: defaultDaemonHttp(config.apiBaseUrl),
    reader: defaultCommitReader(config.cwd),
  }
  let processed = 0
  for (;;) {
    const next = selectNextPending(queue)
    if (!next) break
    const outcome = await processCheckpoint(next, ctx)
    queue = upsertQueue(queue, outcome.record)
    fs.writeFileSync(queuePath, serializeQueue(queue))
    processed++
    if (outcome.result !== 'done') break
  }
  return processed
}

/**
 * Loop persistente: drena a fila e dorme (com backoff quando há pendências
 * deferidas). Sai só quando morto (SIGTERM). NUNCA mata/toca o preview.
 */
export async function runDaemonLoop(
  cwd: string,
  opts: { idleMs?: number } = {},
): Promise<void> {
  const config = readProjectConfig(cwd)
  if (!config) {
    process.stderr.write('[daemon] .supremo/project.json ausente/incompleto.\n')
    return
  }
  const keychain = resolveKeychain()
  const daemonConfig: DaemonConfig = {
    projectId: config.projectId,
    apiBaseUrl: config.apiBaseUrl,
    cwd,
    getSecret: () => keychain.get(config.projectId),
  }
  const idleMs = opts.idleMs ?? 3000
  let stopped = false
  process.on('SIGTERM', () => {
    stopped = true
  })
  while (!stopped) {
    let queue: CheckpointRecord[] = []
    try {
      queue = parseQueue(fs.readFileSync(path.join(cwd, QUEUE_FILE), 'utf8'))
    } catch {
      /* sem fila ainda */
    }
    await drainOnce(daemonConfig)
    try {
      fs.rmSync(path.join(cwd, NOTIFY_FILE))
    } catch {
      /* nenhum sinal pendente */
    }
    const attempts = minPendingAttempts(queue)
    await sleep(attempts != null ? backoffDelayMs(attempts) : idleMs)
  }
}
