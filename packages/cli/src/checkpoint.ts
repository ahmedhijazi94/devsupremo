import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/**
 * `supremo checkpoint "<resumo>"` — a ÚNICA coisa que o agente faz ao concluir um
 * pedido. É 100% LOCAL: valida que há mudança, cria o commit do checkpoint,
 * registra a metadata e avisa o daemon. NÃO fala com a rede, GitHub, CI, PR ou
 * merge — retorna na hora. O daemon empurra em background (ver daemon.ts).
 *
 * A lógica é PURA e injeta o I/O (git/fs/uuid/now) para ser testável sem repo real.
 */

export type RiskLevel = 'low' | 'medium' | 'high'
export type PushStatus =
  | 'local'
  | 'upload_pending'
  | 'publishing'
  | 'published'
  | 'integrated'
  | 'push_failed'

export interface CheckpointRecord {
  checkpointId: string
  projectId: string
  commitSha: string
  parentCheckpointId: string | null
  createdAt: string
  summary: string
  riskLevel: RiskLevel
  migrations: string[]
  changedPaths: string[]
  pushStatus: PushStatus
  attempts: number
  prNumber?: number
  integrationBranch?: string
  /** Presente quando este checkpoint é o "E" resultante de um restore (para B). */
  restoredFromCheckpointId?: string
  /** Metadata de origem (Histórico), quando o HOST do agente fornecer. Opcional. */
  conversationId?: string
  messageId?: string
  originAgent?: string
}

// ── Puro ─────────────────────────────────────────────────────────────────────

/** Há algo para commitar? (git status --porcelain não-vazio) */
export function hasChanges(porcelain: string): boolean {
  return porcelain.trim().length > 0
}

/** Extrai os paths alterados do `git status --porcelain` (trata rename). */
export function parseChangedPaths(porcelain: string): string[] {
  const out: string[] = []
  for (const raw of porcelain.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line.trim().length === 0) continue
    let rest = line.slice(3)
    const arrow = rest.indexOf(' -> ')
    if (arrow !== -1) rest = rest.slice(arrow + 4)
    rest = rest.trim().replace(/^"(.*)"$/, '$1')
    if (rest) out.push(rest)
  }
  return out
}

const HIGH_RE: RegExp[] = [
  /supabase\/migrations\/.*\.sql$/,
  /(^|\/)app\/api\/.*route\.(ts|tsx|js|jsx)$/,
  /(^|\/)actions\//,
  /\.github\/workflows\//,
  /(^|\/)middleware\.(ts|js)$/,
  /\.(rls|policy)\.(sql|ts)$/,
  /(^|\/)(next\.config|tsconfig|package)\.(ts|js|json)$/,
  /(^|\/)vercel\.json$/,
]
const MEDIUM_RE: RegExp[] = [/(^|\/)(lib|hooks|stores|server|src\/lib)\//]

/**
 * Classifica o risco do checkpoint pelos paths (espelha o verify adaptativo):
 * HIGH para superfícies sensíveis (migrations, rotas de API, server actions,
 * auth/RLS, workflows, config estrutural); MEDIUM para lógica/lib ou mudança
 * ampla; LOW para o resto (cosmético/copy/UI). Conservador: na dúvida, sobe.
 */
export function classifyCheckpointRisk(paths: readonly string[]): RiskLevel {
  if (paths.some((p) => HIGH_RE.some((re) => re.test(p)))) return 'high'
  if (paths.length > 8 || paths.some((p) => MEDIUM_RE.some((re) => re.test(p)))) {
    return 'medium'
  }
  return 'low'
}

/** Migrations tocadas por este checkpoint (para o modelo de restore). */
export function detectMigrations(paths: readonly string[]): string[] {
  return paths.filter((p) => /supabase\/migrations\/.*\.sql$/.test(p))
}

/** Parent = o último checkpoint da fila (linearidade da linha do tempo). */
export function nextParentId(queue: readonly CheckpointRecord[]): string | null {
  return queue.length > 0 ? queue[queue.length - 1]!.checkpointId : null
}

export function buildCheckpointRecord(input: {
  checkpointId: string
  projectId: string
  commitSha: string
  parentCheckpointId: string | null
  createdAt: string
  summary: string
  changedPaths: readonly string[]
  restoredFromCheckpointId?: string
  conversationId?: string
  messageId?: string
  originAgent?: string
}): CheckpointRecord {
  return {
    checkpointId: input.checkpointId,
    projectId: input.projectId,
    commitSha: input.commitSha,
    parentCheckpointId: input.parentCheckpointId,
    createdAt: input.createdAt,
    summary: input.summary,
    riskLevel: classifyCheckpointRisk(input.changedPaths),
    migrations: detectMigrations(input.changedPaths),
    changedPaths: [...input.changedPaths],
    pushStatus: 'local',
    attempts: 0,
    ...(input.restoredFromCheckpointId
      ? { restoredFromCheckpointId: input.restoredFromCheckpointId }
      : {}),
    ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    ...(input.messageId ? { messageId: input.messageId } : {}),
    ...(input.originAgent ? { originAgent: input.originAgent } : {}),
  }
}

export function serializeQueue(queue: readonly CheckpointRecord[]): string {
  return queue.map((r) => JSON.stringify(r)).join('\n') + (queue.length ? '\n' : '')
}

export function parseQueue(jsonl: string): CheckpointRecord[] {
  // Journal append-only: criação e resultados do daemon usam o mesmo formato.
  // Atualizar um ID preserva sua posição original (a ordem dos checkpoints),
  // mesmo quando o resultado de A chega depois da criação de B.
  const records = new Map<string, CheckpointRecord>()
  for (const line of jsonl.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      const record = JSON.parse(t) as CheckpointRecord
      records.set(record.checkpointId, record)
    } catch {
      // linha corrompida: ignora (não derruba o daemon)
    }
  }
  return [...records.values()]
}

// ── Orquestração (I/O injetável) ─────────────────────────────────────────────

export interface CheckpointDeps {
  /** Roda git e devolve stdout (lança em erro). NUNCA recebe token. */
  git: (args: string[]) => string
  readQueue: () => CheckpointRecord[]
  appendQueue: (record: CheckpointRecord) => void
  /** Avisa o daemon local (best-effort; escrever na fila já é o sinal). */
  notifyDaemon: () => void
  now: () => string
  uuid: () => string
}

export class NothingToCheckpointError extends Error {
  constructor() {
    super('Nada para checkpoint — nenhuma mudança no worktree.')
    this.name = 'NothingToCheckpointError'
  }
}

/**
 * Executa o checkpoint LOCAL e retorna o registro. Passos (sem rede):
 *   1. valida que há mudança (senão lança);
 *   2. captura os paths alterados (antes do commit);
 *   3. `git add -A` + commit do checkpoint;
 *   4. lê o SHA do commit e monta o registro (risco, migrations, parent);
 *   5. anexa à fila e avisa o daemon;
 *   6. retorna imediatamente.
 */
export function runCheckpoint(
  summary: string,
  projectId: string,
  deps: CheckpointDeps,
  origin: {
    conversationId?: string
    messageId?: string
    originAgent?: string
    /**
     * v3.3 (sincronização entre máquinas) — quando fornecido, substitui
     * `nextParentId(queue)` como base declarada do checkpoint. Quem chama
     * (bin.ts) calcula isto via `resolveParentCheckpointId` (fila local +
     * último estado remoto CONFIRMADAMENTE sincronizado — ver sync.ts):
     * numa máquina recém-sincronizada, a fila local sozinha não sabe que a
     * base real avançou. `undefined` (padrão) preserva o comportamento de
     * sempre — só a fila local decide.
     */
    parentCheckpointIdOverride?: string | null
  } = {},
): CheckpointRecord {
  const porcelain = deps.git(['status', '--porcelain'])
  if (!hasChanges(porcelain)) throw new NothingToCheckpointError()

  const changedPaths = parseChangedPaths(porcelain)

  deps.git(['add', '-A'])
  deps.git(['commit', '-m', `checkpoint: ${summary}`])
  const commitSha = deps.git(['rev-parse', 'HEAD']).trim()

  const queue = deps.readQueue()
  const { parentCheckpointIdOverride, ...restOrigin } = origin
  const record = buildCheckpointRecord({
    checkpointId: deps.uuid(),
    projectId,
    commitSha,
    parentCheckpointId:
      parentCheckpointIdOverride !== undefined ? parentCheckpointIdOverride : nextParentId(queue),
    createdAt: deps.now(),
    summary,
    changedPaths,
    ...restOrigin,
  })

  deps.appendQueue(record)
  deps.notifyDaemon()
  return record
}

// ── Adapters reais (I/O; cobertos por E2E) ───────────────────────────────────

export const CHECKPOINT_DIR = '.supremo/checkpoints'
export const QUEUE_FILE = `${CHECKPOINT_DIR}/queue.jsonl`
export const NOTIFY_FILE = `${CHECKPOINT_DIR}/notify`

/** Lê o projectId de `.supremo/project.json` (não sensível). */
export function readProjectId(cwd: string): string | null {
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(cwd, '.supremo/project.json'), 'utf8'),
    ) as { projectId?: string }
    return raw.projectId ?? null
  } catch {
    return null
  }
}

export function defaultCheckpointDeps(cwd: string): CheckpointDeps {
  const queuePath = path.join(cwd, QUEUE_FILE)
  return {
    git: (args) =>
      execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    readQueue: () => {
      try {
        return parseQueue(fs.readFileSync(queuePath, 'utf8'))
      } catch {
        return []
      }
    },
    appendQueue: (record) => {
      fs.mkdirSync(path.dirname(queuePath), { recursive: true })
      fs.appendFileSync(queuePath, JSON.stringify(record) + '\n')
    },
    notifyDaemon: () => {
      try {
        fs.mkdirSync(path.join(cwd, CHECKPOINT_DIR), { recursive: true })
        fs.writeFileSync(path.join(cwd, NOTIFY_FILE), new Date().toISOString())
      } catch {
        // fila já foi escrita; o daemon também faz polling
      }
    },
    now: () => new Date().toISOString(),
    uuid: () => crypto.randomUUID(),
  }
}
