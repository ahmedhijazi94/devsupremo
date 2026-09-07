import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  defaultCheckpointDeps,
  classifyCheckpointRisk,
  detectMigrations,
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
import { startDatabaseWorker } from './database-queue'
import { runDatabaseDirect } from './database'
import { startFeedbackWorker } from './feedback'
import { evidenceFor, startLocalValidationWorker } from './turn-validation'
import { gitText, readJson, TURN_DIR, withTurnLock } from './turn-workspace'
import {
  applyRestore,
  defaultRestoreDeps,
  RestoreTargetNotFoundLocallyError,
  type RestoreDeps,
} from './restore'

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
  for (const r of queue) if (RETRIABLE.has(r.pushStatus) && r.validationStatus !== 'failed') return r
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
  /** Presente quando este checkpoint é o "E" resultante de um restore. */
  restoredFromCheckpointId?: string
  conversationId?: string
  messageId?: string
  originAgent?: string
}

export interface PendingRestore {
  restoreRequestId: string
  targetCheckpointId: string
  targetSummary: string
}

export interface DaemonHttp {
  /** Status-only notification, including failed checkpoints that cannot upload code. */
  reportLocalCheckpoint?(input: LocalCheckpointReportInput): Promise<void>
  /**
   * POST /api/checkpoint/publish. Envia o CHANGESET; recebe só {prNumber}. NUNCA
   * recebe token. Lança NetworkError/AuthError/ConflictError.
   */
  publish(input: PublishInput): Promise<{ prNumber: number }>
  /** POST /api/checkpoint/restore-poll. Reivindica pedidos "Restaurar" pendentes. */
  pollRestores(input: { deviceSecret: string; projectId: string }): Promise<PendingRestore[]>
  /** POST /api/checkpoint/restore-report — fecha o pedido de restore. */
  reportRestoreApplied(input: {
    deviceSecret: string
    restoreRequestId: string
    resultCheckpointId: string | null
  }): Promise<void>
  reportRestoreFailed(input: {
    deviceSecret: string
    restoreRequestId: string
    error: string
  }): Promise<void>
  /**
   * POST /api/checkpoint/sync-status (v3.3 — sincronização entre máquinas).
   * Checagem LEVE (um SELECT, nunca GitHub) do checkpoint mais recente
   * CONHECIDO do projeto — usada pelo comando `sync`, uma vez por sessão.
   * TIMEOUT CURTO embutido no adapter: nunca deixa a sessão esperando.
   */
  syncStatus(input: { deviceSecret: string; projectId: string }): Promise<SyncStatusResult>
}

export interface LocalCheckpointReportInput {
  deviceSecret: string
  projectId: string
  checkpointId: string
  commitSha: string
  createdAt: string
  revision: number
  validationStatus: NonNullable<CheckpointRecord['validationStatus']>
  validatedSha: string | null
  uploadStatus: 'local' | 'upload_pending' | 'push_failed'
}

/** No arbitrary text leaves the computer before the source safety check passes. */
export function localReportFor(record: CheckpointRecord, revision: number): Omit<LocalCheckpointReportInput, 'deviceSecret'> | null {
  if (!['local', 'upload_pending', 'push_failed'].includes(record.pushStatus)) return null
  const validatedSha = record.validatedSha === record.commitSha ? record.validatedSha : null
  let validationStatus = record.validationStatus ?? 'pending'
  if (['passed', 'deferred'].includes(validationStatus) && !validatedSha) validationStatus = 'pending'
  return {
    projectId: record.projectId, checkpointId: record.checkpointId, commitSha: record.commitSha,
    createdAt: record.createdAt, revision, validationStatus, validatedSha,
    uploadStatus: record.pushStatus as LocalCheckpointReportInput['uploadStatus'],
  }
}

export interface SyncStatusResult {
  latest: {
    id: string
    createdAt: string
    summary: string
    pushStatus: string
    integrationStatus: string | null
    /** Branch de integração REAL já gerenciada pelo Supremo — existe assim
     * que pushStatus chega a 'published' (continuidade entre máquinas nunca
     * espera o CI/merge; ver sync.ts). */
    integrationBranch: string | null
    /** SHA exato deste checkpoint em `integrationBranch` (Git Data API) — o
     * `sync` pina o fast-forward nele, nunca no tip móvel da branch (que
     * pode ganhar um checkpoint novo de outra máquina em pleno voo do
     * fetch; ver sync.ts). `null` enquanto ainda 'publishing'. */
    publishedSha: string | null
  } | null
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
  if (record.projectId !== ctx.projectId) return { record, result: 'failed', reason: 'project_mismatch' }
  if (!record.validationStatus || (record.validationStatus !== 'passed' && record.validationStatus !== 'deferred' || record.validatedSha !== record.commitSha)) {
    return { record, result: 'deferred', reason: 'local_validation_required' }
  }
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
      ...(record.restoredFromCheckpointId
        ? { restoredFromCheckpointId: record.restoredFromCheckpointId }
        : {}),
      ...(record.conversationId ? { conversationId: record.conversationId } : {}),
      ...(record.messageId ? { messageId: record.messageId } : {}),
      ...(record.originAgent ? { originAgent: record.originAgent } : {}),
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

/** v3.3 — sync-status é uma checagem de sessão, não um retry em background:
 * nunca deixa a PRIMEIRA mensagem esperando. Latência é prioridade forte aqui
 * — 2s no máximo, mesmo com backend lento/indisponível. As demais chamadas
 * (publish/restore) não levam timeout de propósito — são do daemon, que já
 * retenta com backoff. */
export const SYNC_STATUS_TIMEOUT_MS = 2000

export function defaultDaemonHttp(apiBaseUrl: string): DaemonHttp {
  const base = apiBaseUrl.replace(/\/$/, '')
  // CodeQL js/file-access-to-http sinaliza dado de arquivo (o conteúdo dos
  // arquivos do changeset, lido por defaultCommitReader em changeset.ts)
  // chegando a um fetch(). Isso é o PROPÓSITO desta função: enviar o
  // checkpoint (código do PRÓPRIO usuário) ao backend do Supremo que ele
  // mesmo configurou (apiBaseUrl vem de .supremo/project.json, escrito pelo
  // bootstrap — nunca de input não confiável), não uma exfiltração acidental
  // de um arquivo sensível não relacionado. Suprimido nas 2 linhas exatas
  // abaixo com esta justificativa — a regra e o job continuam ativos para
  // qualquer outro fluxo novo.
  const postJson = async (route: string, body: unknown, timeoutMs?: number): Promise<unknown> => {
    let res: Response
    const controller = timeoutMs != null ? new AbortController() : undefined
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : undefined
    try {
      // codeql[js/file-access-to-http] changeset do usuário → backend que ele configurou (ver nota acima)
      res = await fetch(`${base}${route}`, {
        method: 'POST',
        redirect: 'error',
        headers: { 'Content-Type': 'application/json' },
        // codeql[js/file-access-to-http] mesmo fluxo intencional (ver nota acima)
        body: JSON.stringify(body),
        ...(controller ? { signal: controller.signal } : {}),
      })
    } catch {
      // Aborto por timeout cai aqui também (AbortError) — mesmo tratamento:
      // "não deu pra falar com o backend agora", nunca trava o chamador.
      if (timer) clearTimeout(timer)
      throw new NetworkError('offline')
    }
    try {
      if (res.status === 401 || res.status === 403) throw new AuthError(`${res.status}`)
      if (res.status === 409) throw new ConflictError('conflict')
      if (!res.ok) throw new NetworkError(`${res.status}`)
      // Keep the deadline active while reading the body too, not only headers.
      return await res.json().catch(() => { throw new NetworkError('invalid_response') })
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
  return {
    reportLocalCheckpoint: async (input) => {
      const data = await postJson('/api/checkpoint/local-report', input, SYNC_STATUS_TIMEOUT_MS) as { reported?: boolean }
      if (data.reported !== true) throw new NetworkError('report_not_acknowledged')
    },
    publish: async (input) => {
      const data = (await postJson('/api/checkpoint/publish', input)) as { prNumber?: number }
      return { prNumber: data.prNumber ?? 0 }
    },
    pollRestores: async (input) => {
      const data = (await postJson('/api/checkpoint/restore-poll', input)) as {
        requests?: PendingRestore[]
      }
      return data.requests ?? []
    },
    reportRestoreApplied: async (input) => {
      await postJson('/api/checkpoint/restore-report', {
        deviceSecret: input.deviceSecret,
        restoreRequestId: input.restoreRequestId,
        status: 'applied',
        resultCheckpointId: input.resultCheckpointId,
      })
    },
    reportRestoreFailed: async (input) => {
      await postJson('/api/checkpoint/restore-report', {
        deviceSecret: input.deviceSecret,
        restoreRequestId: input.restoreRequestId,
        status: 'failed',
        error: input.error,
      })
    },
    syncStatus: async (input) => {
      const data = (await postJson(
        '/api/checkpoint/sync-status',
        input,
        SYNC_STATUS_TIMEOUT_MS,
      )) as SyncStatusResult
      return { latest: data.latest ?? null }
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

/**
 * (PURA) Classifica o erro de `process.kill(pid, 0)`. Só `ESRCH` prova que o
 * processo NÃO existe mais. `EPERM` (comum em sandboxes/macOS — o pid existe
 * e pode estar saudável, só não é sinalizável a partir deste contexto) ou
 * QUALQUER outro erro NÃO prova que morreu — fica `'unknown'`.
 *
 * Mesma classificação já validada no supervisor de preview
 * (`classifyPidSignalError` em `src/lib/templates/harness.ts`, que gera
 * `scripts/preview.mjs`) — reaproveitada aqui, não uma lógica nova: os dois
 * pacotes não compartilham módulos (o preview é gerado como script
 * standalone pro projeto do usuário; o daemon é a própria CLI publicada),
 * então o padrão se repete de propósito em vez de inventar outro.
 *
 * BUG REAL: `pidAlive` tratava EPERM como "morto" — `ensureDaemon` perdia o
 * rastro de um daemon vivo e saudável (comum em sandboxes que isolam sinais
 * entre contextos) e subia uma SEGUNDA instância por cima, duplicando o
 * processo que envia checkpoints.
 */
export function classifyPidSignalError(code: string | null | undefined): 'dead' | 'unknown' {
  return code === 'ESRCH' ? 'dead' : 'unknown'
}

/**
 * Estado do pid via `process.kill(pid, 0)` — `'unknown'` (não dá pra
 * confirmar vivo, mas também não dá pra provar morto) nunca vira `'dead'`.
 */
function pidState(pid: number): 'alive' | 'dead' | 'unknown' {
  try {
    process.kill(pid, 0)
    return 'alive'
  } catch (err) {
    return classifyPidSignalError((err as NodeJS.ErrnoException | undefined)?.code)
  }
}

/**
 * `'unknown'` conta como vivo — combinado com o pidfile (o outro sinal já
 * existente: só reflete um pid que ESTE processo escreveu ao subir um
 * daemon) antes de decidir religar. Nunca sobe uma segunda instância só
 * porque o SO negou o sinal (EPERM) de um processo que continua de pé.
 */
function pidAlive(pid: number): boolean {
  return pidState(pid) !== 'dead'
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
  const localBin = path.join(cwd, 'node_modules/.bin/supremo')
  const binPath = fs.existsSync(localBin) ? localBin : process.argv[1] ?? ''
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

export interface DaemonStatus {
  running: boolean
  /** Sem healthcheck HTTP próprio (diferente do preview): vivo = saudável. */
  healthy: boolean
  pid: number | null
  pendingCheckpoints: number
}

export function daemonStatus(cwd: string): DaemonStatus {
  const pid = readPid(cwd)
  const running = pid != null && pidAlive(pid)
  let pendingCheckpoints = 0
  try {
    const queue = parseQueue(fs.readFileSync(path.join(cwd, QUEUE_FILE), 'utf8'))
    pendingCheckpoints = queue.filter((r) => RETRIABLE.has(r.pushStatus)).length
  } catch {
    // sem fila ainda: 0 pendências
  }
  return { running, healthy: running, pid, pendingCheckpoints }
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

const LOCAL_REPORT_RECEIPTS = `${CHECKPOINT_DIR}/reported.json`

/** Runs independently of publication/restore network calls and their backoff. */
export async function reportLocalCheckpoints(config: DaemonConfig, http = defaultDaemonHttp(config.apiBaseUrl)): Promise<number> {
  const secret = config.getSecret()
  if (!secret || !http.reportLocalCheckpoint) return 0
  let raw: string
  try { raw = fs.readFileSync(path.join(config.cwd, QUEUE_FILE), 'utf8') } catch { return 0 }
  const queue = parseQueue(raw)
  const revisions = new Map<string, number>()
  for (const line of raw.split('\n').filter(Boolean)) {
    try {
      const event = JSON.parse(line) as { checkpointId?: string }
      if (typeof event.checkpointId === 'string') revisions.set(event.checkpointId, (revisions.get(event.checkpointId) ?? 0) + 1)
    } catch { /* A partial append will be read at the next tick. */ }
  }
  const receiptsPath = path.join(config.cwd, LOCAL_REPORT_RECEIPTS)
  const previous = readJson(receiptsPath)
  const receipts: Record<string, unknown> = previous && typeof previous === 'object' && !Array.isArray(previous)
    ? previous as Record<string, unknown> : {}
  let reported = 0
  for (const record of queue) {
    if (record.projectId !== config.projectId) continue
    const input = localReportFor(record, revisions.get(record.checkpointId) ?? 1)
    if (!input) continue
    const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex')
    if (receipts[record.checkpointId] === fingerprint) continue
    try {
      await http.reportLocalCheckpoint({ ...input, deviceSecret: secret })
    } catch {
      // Never acknowledge a failed report or prevent source publication from progressing.
      break
    }
    receipts[record.checkpointId] = fingerprint
    fs.writeFileSync(`${receiptsPath}.tmp`, JSON.stringify(receipts), { mode: 0o600 })
    fs.renameSync(`${receiptsPath}.tmp`, receiptsPath)
    reported += 1
    if (reported >= 20) break
  }
  return reported
}

function startLocalReportWorker(config: DaemonConfig): () => void {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const tick = async (): Promise<void> => {
    try { await reportLocalCheckpoints(config) }
    catch { process.stderr.write('[daemon] Registro local pendente; será reenviado.\n') }
    if (!stopped) timer = setTimeout(() => { void tick() }, 1500)
  }
  void tick()
  return () => { stopped = true; if (timer) clearTimeout(timer) }
}

/**
 * Consulta e aplica pedidos de "Restaurar" (v3.1 finalização). Roda ANTES da
 * fila de checkpoints normais: se um restore criar o checkpoint "E", ele já
 * entra na fila a tempo de ser publicado nesta mesma passada. NUNCA falha
 * silenciosamente — todo pedido reivindicado termina 'applied' ou 'failed' no
 * backend, mesmo quando o alvo não existe no histórico local desta máquina.
 *
 * `http`/`deps` são injetáveis (testáveis sem rede/git real); em produção
 * `drainOnce` chama sem eles e usa os adapters reais.
 */
export async function processRestores(
  config: DaemonConfig,
  overrides: { http?: DaemonHttp; deps?: RestoreDeps } = {},
): Promise<number> {
  const active = readJson(path.join(config.cwd, TURN_DIR, 'state.json')) as { turn?: { status?: string } } | null
  if (active?.turn?.status === 'active') return 0
  const secret = config.getSecret()
  if (!secret) return 0

  const http = overrides.http ?? defaultDaemonHttp(config.apiBaseUrl)
  let pending: Awaited<ReturnType<DaemonHttp['pollRestores']>>
  try {
    pending = await http.pollRestores({ deviceSecret: secret, projectId: config.projectId })
  } catch {
    return 0 // offline: tenta de novo no próximo tick, sem derrubar o daemon
  }
  if (pending.length === 0) return 0

  const deps = overrides.deps ?? defaultRestoreDeps(defaultCheckpointDeps(config.cwd), config.cwd)
  for (const req of pending) {
    try {
      const outcome = await withTurnLock(config.cwd, () => {
        // Polling crosses a network boundary. A new turn may have claimed the workspace meanwhile.
        const latest = readJson(path.join(config.cwd, TURN_DIR, 'state.json')) as { turn?: { status?: string } } | null
        if (latest?.turn?.status === 'active' || readJson(path.join(config.cwd, TURN_DIR, 'mutation-lease.json')) !== null) {
          throw new Error('Workspace ocupado por um turno; restauração não aplicada.')
        }
        return applyRestore(req.targetCheckpointId, req.targetSummary, config.projectId, deps)
      })
      // Sinaliza (v3-12) — nunca falha o restore por causa disto: a migration
      // já foi preservada como está (nunca reescrita), isto é só visibilidade
      // pra um caso que nunca deveria acontecer (migration histórica editada
      // in-place em algum checkpoint).
      if (outcome.migrationConflicts.length > 0) {
        console.error(
          `⚠ restore: ${outcome.migrationConflicts.length} migration(s) com conteúdo divergente entre o estado atual e o alvo do restore — preservada(s) como está(ão) (nunca reescrita(s)): ${outcome.migrationConflicts.join(', ')}`,
        )
      }
      await http.reportRestoreApplied({
        deviceSecret: secret,
        restoreRequestId: req.restoreRequestId,
        resultCheckpointId: outcome.applied ? (outcome.record?.checkpointId ?? null) : null,
      })
    } catch (err) {
      const message =
        err instanceof RestoreTargetNotFoundLocallyError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'falha desconhecida ao aplicar restore'
      await http
        .reportRestoreFailed({ deviceSecret: secret, restoreRequestId: req.restoreRequestId, error: message })
        .catch(() => {})
    }
  }
  return pending.length
}

/** Processa o snapshot atual; resultados são anexados sem apagar novos pedidos. */
export async function drainOnce(config: DaemonConfig): Promise<number> {
  // Restores primeiro: um checkpoint "E" resultante já entra na fila a tempo.
  await processRestores(config)

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
    let next = selectNextPending(queue)
    if (!next) break
    if (!next.validationStatus) {
      // Upgrade legacy records into the safety worker; no environment authority
      // is invented here and no source is sent before exact-SHA evidence exists.
      fs.appendFileSync(queuePath, serializeQueue([{ ...next, validationStatus: 'pending' }]))
      break
    }
    if (next.validationStatus) {
      const evidence = evidenceFor(config.cwd, next)
      if (!evidence || !['passed', 'deferred'].includes(evidence.status)) break
    }
    const nextId = next.checkpointId
    const earlier = queue.slice(0, queue.findIndex((item) => item.checkpointId === nextId))
    const lastPublished = earlier.filter((item) => ['published', 'integrated'].includes(item.pushStatus)).at(-1)
    const unpublished = earlier.slice(lastPublished ? earlier.indexOf(lastPublished) + 1 : 0)
    if (unpublished.some((item) => item.validationStatus === 'failed')) {
      const first = unpublished[0]!
      const changesetBaseSha = lastPublished?.commitSha ?? gitText(config.cwd, ['rev-parse', `${first.commitSha}^`])
      const changedPaths = gitText(config.cwd, ['diff', '--name-only', '-z', changesetBaseSha, next.commitSha]).split('\0').filter(Boolean)
      const rebased = { ...next, parentCheckpointId: lastPublished?.checkpointId ?? first.parentCheckpointId,
        changesetBaseSha, changedPaths, riskLevel: classifyCheckpointRisk(changedPaths), migrations: detectMigrations(changedPaths) }
      if (next.changesetBaseSha !== changesetBaseSha) {
        // Skipping an unpublished failed snapshot expands the change under review.
        // Its full diff must be validated before the daemon can publish it.
        fs.appendFileSync(queuePath, serializeQueue([{ ...rebased, validationStatus: 'pending' }]))
        break
      }
      next = rebased
    }
    const outcome = await processCheckpoint(next, ctx)
    queue = upsertQueue(queue, outcome.record)
    // Nunca regravar o snapshot lido antes da rede: o agente pode ter anexado
    // novos checkpoints enquanto este envio estava em andamento.
    fs.appendFileSync(queuePath, serializeQueue([outcome.record]))
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
  // Independente do upload/CI/backoff: o banco responde mesmo com checkpoint pendente.
  const stopLocalValidationWorker = startLocalValidationWorker(cwd)
  const stopLocalReportWorker = startLocalReportWorker(daemonConfig)
  const stopDatabaseWorker = startDatabaseWorker(cwd, (operation) => runDatabaseDirect(operation, cwd))
  const stopFeedbackWorker = startFeedbackWorker(daemonConfig)
  process.on('SIGTERM', () => {
    stopped = true
    stopDatabaseWorker()
    stopFeedbackWorker()
    stopLocalValidationWorker()
    stopLocalReportWorker()
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
