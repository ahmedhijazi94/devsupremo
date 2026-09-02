import { execFileSync, spawn } from 'node:child_process'
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
import { resolveKeychain } from './keychain'

/**
 * SUPREMO CHECKPOINT DAEMON — envia os checkpoints em BACKGROUND.
 *
 * O agente nunca faz `git push`: ele só cria o checkpoint local. O daemon (uma
 * peça de infraestrutura persistente, como o preview) consome a fila e, para
 * cada checkpoint:
 *   1. autentica com o SECRET da máquina (keychain; nunca em argv/log);
 *   2. pede o push-grant ao backend (token escopado ao repo, permissões mínimas);
 *   3. empurra a branch de integração (reuse/rotate) SEM tocar o worktree do
 *      usuário e NUNCA na main;
 *   4. revoga o token e pede ao backend para garantir a PR;
 *   5. NÃO espera CI — segue para o próximo.
 *
 * A DECISÃO (o que empurrar, qual branch, anti-TOCTOU) é pura/testada; o git/HTTP
 * é injetado para o núcleo ser testável sem rede nem repo real.
 */

// ── Estado da fila (puro) ────────────────────────────────────────────────────

/** Estados que ainda precisam de trabalho do daemon (retriáveis, idempotentes). */
const RETRIABLE: ReadonlySet<PushStatus> = new Set<PushStatus>([
  'local',
  'push_pending',
  'pushing',
])

/**
 * Próximo checkpoint a processar, PRESERVANDO A ORDEM da fila (o daemon integra
 * A antes de B). Pula os já concluídos ('pushed'/'integrated') e os terminais
 * ('push_failed'). Retorna null quando não há nada a fazer.
 */
export function selectNextPending(
  queue: readonly CheckpointRecord[],
): CheckpointRecord | null {
  for (const r of queue) if (RETRIABLE.has(r.pushStatus)) return r
  return null
}

/** Backoff exponencial com teto (retry de rede offline). */
export function backoffDelayMs(attempts: number, baseMs = 2000, maxMs = 60000): number {
  const n = Math.max(0, attempts)
  return Math.min(maxMs, baseMs * 2 ** n)
}

// ── Transporte da credencial de git (NUNCA em argv/log/git config) ───────────

export const MAIN_BRANCHES = new Set(['main', 'master'])

/** Recusa qualquer push cujo alvo seja a branch protegida. */
export function assertNotMain(branch: string): void {
  if (MAIN_BRANCHES.has(branch)) {
    throw new Error(`Recusado: push na branch protegida "${branch}".`)
  }
}

export function cleanRemoteUrl(repoFullName: string): string {
  return `https://github.com/${repoFullName}.git`
}

/**
 * Credential helper efêmero: o token vem SÓ da env SUPREMO_GIT_TOKEN, lida por
 * este helper no instante da autenticação do git. O primeiro `credential.helper=`
 * zera os helpers do sistema (só o nosso responde). O token nunca entra em argv,
 * na URL, no .git/config, no log nem no stdout.
 */
export function gitCredentialHelper(): string {
  return "!f() { test \"$1\" = get && printf 'username=x-access-token\\npassword=%s\\n' \"$SUPREMO_GIT_TOKEN\"; }; f"
}

/** Args base do git com o credential helper efêmero (sem token no comando). */
export function gitCredentialArgs(): string[] {
  return ['-c', 'credential.helper=', '-c', `credential.helper=${gitCredentialHelper()}`]
}

/**
 * Args do push por FAST-FORWARD de um SHA para uma branch de integração (reuse).
 * O token NÃO aparece aqui — vai pela env do processo. Recusa a main.
 */
export function gitPushArgs(
  repoFullName: string,
  srcSha: string,
  branch: string,
): string[] {
  assertNotMain(branch)
  return [
    ...gitCredentialArgs(),
    'push',
    cleanRemoteUrl(repoFullName),
    `${srcSha}:refs/heads/${branch}`,
  ]
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

export interface IntegrationPlan {
  action: 'reuse' | 'rotate'
  branch: string
  base: string
  expectedBaseSha: string
  pushSha?: string
  deltaRange?: { fromSha: string | null; toSha: string }
}

export interface GrantResponse {
  token: string
  repoFullName: string
  plan: IntegrationPlan
}

export interface DaemonHttp {
  /** POST /api/checkpoint/push-grant. Lança NetworkError/AuthError. */
  requestGrant(input: {
    deviceSecret: string
    projectId: string
    record: CheckpointRecord
  }): Promise<GrantResponse>
  /** POST /api/checkpoint/ensure-pr. Lança NetworkError. */
  ensurePr(input: {
    deviceSecret: string
    projectId: string
    checkpointId: string
    branch: string
    summary: string
  }): Promise<{ prNumber: number }>
  /** DELETE do installation token no GitHub (best-effort; nunca lança). */
  revokeToken(token: string): Promise<void>
}

export interface DaemonGit {
  /** Fetch da main e devolve o SHA real do HEAD remoto (para anti-TOCTOU). */
  fetchMainSha(repoFullName: string, token: string): string
  /** Push fast-forward de um SHA para a branch (reuse). */
  pushReuse(repoFullName: string, pushSha: string, branch: string, token: string): void
  /** Rebase do delta sobre a main atual numa worktree isolada e push (rotate). */
  pushRotate(
    repoFullName: string,
    plan: { branch: string; baseSha: string; fromSha: string | null; toSha: string },
    token: string,
  ): void
}

export interface DaemonContext {
  projectId: string
  getSecret: () => string | null
  http: DaemonHttp
  git: DaemonGit
}

export type ProcessOutcome =
  | { record: CheckpointRecord; result: 'done' }
  | { record: CheckpointRecord; result: 'deferred'; reason: string }
  | { record: CheckpointRecord; result: 'failed'; reason: string }

/**
 * Processa UM checkpoint. Idempotente e retry-safe: reexecutar um checkpoint já
 * empurrado é no-op (fast-forward). NÃO espera CI. Anti-TOCTOU: no rotate,
 * confere a main real antes de empurrar; se avançou, adia (HEAD antigo não integra).
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

  // 1. Push grant (token escopado ao repo).
  let grant: GrantResponse
  try {
    grant = await ctx.http.requestGrant({
      deviceSecret: secret,
      projectId: ctx.projectId,
      record,
    })
  } catch (err) {
    if (err instanceof AuthError) {
      return {
        record: withStatus(record, 'push_failed'),
        result: 'failed',
        reason: 'unauthorized',
      }
    }
    // Offline/rede: vira pending e será retentado com backoff. Não perde nada.
    return {
      record: withStatus(record, 'push_pending', { attempts: record.attempts + 1 }),
      result: 'deferred',
      reason: 'network',
    }
  }

  const { plan, token, repoFullName } = grant
  assertNotMain(plan.branch)

  // 2. Push (reuse/rotate) com anti-TOCTOU. Revoga o token em qualquer saída.
  try {
    if (plan.action === 'reuse') {
      ctx.git.pushReuse(repoFullName, plan.pushSha ?? record.commitSha, plan.branch, token)
    } else {
      const observedMain = ctx.git.fetchMainSha(repoFullName, token)
      if (observedMain !== plan.expectedBaseSha) {
        // A main avançou depois do plano (ex.: A mergeou): re-planeja no próximo
        // tick. HEAD antigo NUNCA integra.
        await ctx.http.revokeToken(token)
        return {
          record: withStatus(record, 'push_pending', {
            attempts: record.attempts + 1,
          }),
          result: 'deferred',
          reason: 'stale_base',
        }
      }
      ctx.git.pushRotate(
        repoFullName,
        {
          branch: plan.branch,
          baseSha: plan.expectedBaseSha,
          fromSha: plan.deltaRange?.fromSha ?? null,
          toSha: plan.deltaRange?.toSha ?? record.commitSha,
        },
        token,
      )
    }
  } catch {
    await ctx.http.revokeToken(token)
    return {
      record: withStatus(record, 'push_pending', { attempts: record.attempts + 1 }),
      result: 'deferred',
      reason: 'push_error',
    }
  }

  // 3. Revoga o token IMEDIATAMENTE após o push (janela mínima).
  await ctx.http.revokeToken(token)
  const pushed = withStatus(record, 'pushing', { integrationBranch: plan.branch })

  // 4. Garante a PR server-side (o daemon NÃO espera CI). Falha de rede aqui
  //    mantém 'pushing' — o próximo tick re-tenta (push já é idempotente).
  try {
    const pr = await ctx.http.ensurePr({
      deviceSecret: secret,
      projectId: ctx.projectId,
      checkpointId: record.checkpointId,
      branch: plan.branch,
      summary: record.summary,
    })
    return {
      record: withStatus(record, 'pushed', {
        integrationBranch: plan.branch,
        prNumber: pr.prNumber,
      }),
      result: 'done',
    }
  } catch {
    return { record: pushed, result: 'deferred', reason: 'ensure_pr_network' }
  }
}

// ── Adapters reais (I/O; cobertos por E2E) ───────────────────────────────────

const GITHUB_API = 'https://api.github.com'

/** Roda git com o token SÓ na env (nunca em argv). Devolve stdout. */
function gitWithToken(args: string[], cwd: string, token: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, SUPREMO_GIT_TOKEN: token },
  })
}

export function defaultDaemonGit(cwd: string): DaemonGit {
  return {
    fetchMainSha: (repoFullName, token) => {
      gitWithToken(
        [...gitCredentialArgs(), 'fetch', cleanRemoteUrl(repoFullName), 'main'],
        cwd,
        token,
      )
      return gitWithToken(['rev-parse', 'FETCH_HEAD'], cwd, token).trim()
    },
    pushReuse: (repoFullName, pushSha, branch, token) => {
      gitWithToken(gitPushArgs(repoFullName, pushSha, branch), cwd, token)
    },
    pushRotate: (repoFullName, plan, token) => {
      assertNotMain(plan.branch)
      const wt = path.join(cwd, '.supremo/checkpoints/wt')
      // Worktree ISOLADA sobre a main real — nunca toca o worktree do usuário.
      try {
        gitWithToken(['worktree', 'remove', '--force', wt], cwd, token)
      } catch {
        /* nenhuma worktree pendente */
      }
      gitWithToken(['worktree', 'add', '--detach', wt, plan.baseSha], cwd, token)
      try {
        const from = plan.fromSha ?? plan.baseSha
        // Reparenta só o delta local sobre a main atual (rebase pula o que já
        // está integrado por patch-id). Sem tocar o worktree do usuário.
        execFileSync('git', ['rebase', '--onto', plan.baseSha, from, plan.toSha], {
          cwd: wt,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, SUPREMO_GIT_TOKEN: token },
        })
        gitWithToken(
          [...gitCredentialArgs(), 'push', cleanRemoteUrl(repoFullName),
            `HEAD:refs/heads/${plan.branch}`],
          wt,
          token,
        )
      } finally {
        try {
          gitWithToken(['worktree', 'remove', '--force', wt], cwd, token)
        } catch {
          /* best-effort */
        }
      }
    },
  }
}

export function defaultDaemonHttp(apiBaseUrl: string): DaemonHttp {
  const base = apiBaseUrl.replace(/\/$/, '')
  const postJson = async (route: string, body: unknown): Promise<unknown> => {
    let res: Response
    try {
      res = await fetch(`${base}${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    } catch {
      throw new NetworkError('offline')
    }
    if (res.status === 401 || res.status === 403) throw new AuthError(`${res.status}`)
    if (!res.ok) throw new NetworkError(`${res.status}`)
    return res.json().catch(() => ({}))
  }
  return {
    requestGrant: async ({ deviceSecret, projectId, record }) => {
      const data = (await postJson('/api/checkpoint/push-grant', {
        deviceSecret,
        projectId,
        checkpointId: record.checkpointId,
        commitSha: record.commitSha,
        parentCheckpointId: record.parentCheckpointId,
        summary: record.summary,
        riskLevel: record.riskLevel,
        changedPaths: record.changedPaths,
        migrations: record.migrations,
      })) as GrantResponse
      return data
    },
    ensurePr: async ({ deviceSecret, projectId, checkpointId, branch, summary }) => {
      const data = (await postJson('/api/checkpoint/ensure-pr', {
        deviceSecret,
        projectId,
        checkpointId,
        branch,
        summary,
      })) as { prNumber: number }
      return data
    },
    revokeToken: async (token) => {
      try {
        await fetch(`${GITHUB_API}/installation/token`, {
          method: 'DELETE',
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
        })
      } catch {
        // best-effort: o token expira em ~1h de qualquer forma
      }
    },
  }
}

// ── Loop do daemon (I/O; cobertos por E2E) ───────────────────────────────────

export interface DaemonConfig {
  projectId: string
  apiBaseUrl: string
  cwd: string
  getSecret: () => string | null
}

/** Lê a fila, processa TODOS os pendentes (em ordem) uma vez, persiste a fila. */
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
    git: defaultDaemonGit(config.cwd),
  }
  let processed = 0
  // Ordem: só avança para B depois de A sair do estado retriável nesta passada.
  for (;;) {
    const next = selectNextPending(queue)
    if (!next) break
    const outcome = await processCheckpoint(next, ctx)
    queue = upsertQueue(queue, outcome.record)
    fs.writeFileSync(queuePath, serializeQueue(queue))
    processed++
    // Deferido (rede/stale): para a passada; o próximo tick re-tenta com backoff.
    if (outcome.result !== 'done') break
  }
  return processed
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
 * Garante UMA instância do daemon rodando (idempotente). Se já há um vivo, reusa;
 * senão, sobe DESACOPLADO (detached + unref) para sobreviver aos turnos do agente
 * — igual ao supervisor de preview. Nunca duas instâncias.
 */
export function ensureDaemon(cwd: string): 'reuse' | 'start' {
  const existing = readPid(cwd)
  if (existing && pidAlive(existing)) return 'reuse'

  fs.mkdirSync(path.join(cwd, CHECKPOINT_DIR), { recursive: true })
  const logPath = path.join(cwd, DAEMON_LOG_FILE)
  const out = fs.openSync(logPath, 'a')
  // Reexecuta ESTE mesmo bin da CLI com o comando `daemon` (sem flags → loop).
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

/** Menor nº de tentativas entre os pendentes — define o backoff da próxima passada. */
function minPendingAttempts(queue: readonly CheckpointRecord[]): number | null {
  let min: number | null = null
  for (const r of queue) {
    if (RETRIABLE.has(r.pushStatus)) {
      min = min === null ? r.attempts : Math.min(min, r.attempts)
    }
  }
  return min
}

/**
 * Loop persistente do daemon: drena a fila, e dorme entre passadas (com backoff
 * quando há pendências deferidas por rede). Sai só quando morto (SIGTERM). NUNCA
 * mata/toca o preview — é infraestrutura independente.
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
    // Consome o sinal do checkpoint (best-effort).
    try {
      fs.rmSync(path.join(cwd, NOTIFY_FILE))
    } catch {
      /* nenhum sinal pendente */
    }
    const attempts = minPendingAttempts(queue)
    await sleep(attempts != null ? backoffDelayMs(attempts) : idleMs)
  }
}
