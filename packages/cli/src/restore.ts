import { execFileSync } from 'node:child_process'
import {
  buildCheckpointRecord,
  hasChanges,
  nextParentId,
  parseChangedPaths,
  type CheckpointDeps,
  type CheckpointRecord,
} from './checkpoint'

/**
 * Restore LOCAL (v3.1 finalização) — "Restaurar B" nunca reescreve histórico:
 * A→B→C→D→E, onde E é um checkpoint NOVO cujo código fica igual ao de B. Sem
 * `git reset`, sem force-push, sem apagar C/D. O daemon:
 *
 *   1. acha o SHA local de B na PRÓPRIA fila desta máquina (o daemon que criou B
 *      é o único com o commit — restore é por-máquina nesta versão);
 *   2. se o worktree tem mudança não commitada, faz uma SALVAGUARDA automática
 *      primeiro (nunca perde trabalho em silêncio);
 *   3. calcula o patch HEAD→B e aplica no índice/worktree (não em B: sobre o
 *      HEAD atual — vira um commit novo, não um "voltar no tempo" destrutivo);
 *   4. se o patch é vazio (já se está no estado de B), não cria checkpoint;
 *   5. cria o checkpoint E normalmente — ele entra na MESMA fila/gates de
 *      qualquer outro checkpoint (publish/CI/merge idênticos).
 *
 * BUG REAL (E2E — restore aplicava o patch mas nunca concluía o checkpoint E):
 * os dois `git commit` deste arquivo (salvaguarda e E) usam `--no-verify` —
 * pulam o hook LOCAL `.githooks/pre-commit` (gerado pelo scaffold, roda
 * `verify.mjs --staged`, que pode incluir um build). Esse hook travando por
 * uma limitação AMBIENTAL do sandbox (porta ocupada, rede indisponível — nada
 * a ver com o código restaurado) travava o `git commit` do daemon PRA SEMPRE:
 * headless, sem ninguém pra perceber, sem timeout. O patch já tinha ido pro
 * worktree (por isso o preview via HMR atualizava), mas o commit nunca
 * terminava — nenhum checkpoint novo, nenhum erro reportado. O hook local é
 * só DX (feedback rápido pro humano iterando); a barreira de verdade continua
 * sendo a CI no servidor — publish/PR/gates continuam OBRIGATÓRIOS antes de
 * qualquer merge, inalterados por este fix.
 */

export class RestoreTargetNotFoundLocallyError extends Error {
  constructor() {
    super(
      'Checkpoint alvo não encontrado no histórico local desta máquina — restore ' +
        'hoje só funciona na MESMA máquina que criou o checkpoint.',
    )
    this.name = 'RestoreTargetNotFoundLocallyError'
  }
}

// ── Puro ─────────────────────────────────────────────────────────────────────

/** O SHA local do checkpoint-alvo, buscado na fila desta máquina (só leitura). */
export function findLocalCommitForCheckpoint(
  queue: readonly CheckpointRecord[],
  checkpointId: string,
): string | null {
  const rec = queue.find((r) => r.checkpointId === checkpointId)
  return rec ? rec.commitSha : null
}

/** Um `git diff` vazio (whitespace) significa "já está no estado do alvo". */
export function isEmptyPatch(patch: string): boolean {
  return patch.trim().length === 0
}

export function restoreCommitMessage(targetSummary: string): string {
  return `checkpoint: Restaurar "${targetSummary}"`
}

export interface RestoreOutcome {
  /** false quando o worktree já estava igual ao alvo — nada a restaurar. */
  applied: boolean
  record: CheckpointRecord | null
}

// ── Orquestração (I/O injetável) ─────────────────────────────────────────────

export interface RestoreDeps extends CheckpointDeps {
  /** Aplica um patch unificado (binário-safe) no índice + worktree. Lança se falhar. */
  applyPatch: (patch: string) => void
}

/**
 * Aplica o restore para `targetCheckpointId` sobre o HEAD atual. NUNCA toca o
 * worktree além do necessário para igualar B; preserva mudança não commitada
 * como uma salvaguarda automática (novo checkpoint) antes de mexer em qualquer
 * coisa.
 */
export function applyRestore(
  targetCheckpointId: string,
  targetSummary: string,
  projectId: string,
  deps: RestoreDeps,
): RestoreOutcome {
  let queue = deps.readQueue()
  const targetSha = findLocalCommitForCheckpoint(queue, targetCheckpointId)
  if (!targetSha) throw new RestoreTargetNotFoundLocallyError()

  // Segurança: NUNCA perde trabalho não commitado — salvaguarda automática antes
  // de tocar em qualquer coisa (seção 22: "prefira preservar automaticamente").
  //
  // `--no-verify` (aqui e no commit do restore abaixo — testes 42-44): pula o
  // hook LOCAL `.githooks/pre-commit` (gerado pelo scaffold — roda `verify.mjs
  // --staged`, que pode incluir um BUILD). BUG REAL (E2E): esse hook pode
  // travar/falhar por uma limitação AMBIENTAL do sandbox (porta ocupada, rede
  // indisponível) sem nenhuma relação com o código sendo restaurado — e como
  // o daemon roda headless, sem ninguém pra perceber/interromper, um `git
  // commit` bloqueado pelo hook trava a thread síncrona do daemon PRA SEMPRE:
  // o patch já tinha sido aplicado no worktree (por isso o HMR via preview
  // atualizava), mas o commit nunca terminava — nenhum checkpoint novo,
  // nenhum erro reportado, `git status` ficava com a mudança pra sempre
  // pendente. O hook local é só uma conveniência de DX (feedback rápido pro
  // humano iterando); a barreira de verdade é sempre a CI no servidor, que
  // esta mudança não toca — a publicação/PR/gates da CI continuam OBRIGATÓRIOS
  // antes de qualquer merge, exatamente como antes.
  const porcelain = deps.git(['status', '--porcelain'])
  if (hasChanges(porcelain)) {
    const changedPaths = parseChangedPaths(porcelain)
    deps.git(['add', '-A'])
    deps.git(['commit', '--no-verify', '-m', 'checkpoint: salvaguarda automática antes do restore'])
    const autoSha = deps.git(['rev-parse', 'HEAD']).trim()
    const autoRecord = buildCheckpointRecord({
      checkpointId: deps.uuid(),
      projectId,
      commitSha: autoSha,
      parentCheckpointId: nextParentId(queue),
      createdAt: deps.now(),
      summary: 'Salvaguarda automática antes do restore',
      changedPaths,
    })
    deps.appendQueue(autoRecord)
    queue = [...queue, autoRecord]
  }

  const currentHead = deps.git(['rev-parse', 'HEAD']).trim()
  const patch = deps.git(['diff', '--binary', currentHead, targetSha])
  if (isEmptyPatch(patch)) {
    return { applied: false, record: null }
  }

  deps.applyPatch(patch)
  // --no-verify: ver comentário acima (salvaguarda) — mesma razão, mesmo hook.
  deps.git(['commit', '--no-verify', '-m', restoreCommitMessage(targetSummary)])
  const newSha = deps.git(['rev-parse', 'HEAD']).trim()

  const record = buildCheckpointRecord({
    checkpointId: deps.uuid(),
    projectId,
    commitSha: newSha,
    parentCheckpointId: nextParentId(queue),
    createdAt: deps.now(),
    summary: `Restaurar "${targetSummary}"`,
    changedPaths: parseChangedPathsFromDiff(patch),
    restoredFromCheckpointId: targetCheckpointId,
  })
  deps.appendQueue(record)
  deps.notifyDaemon()
  return { applied: true, record }
}

/** Extrai os paths tocados de um `git diff --binary` unificado (para o registro). */
function parseChangedPathsFromDiff(patch: string): string[] {
  const out = new Set<string>()
  for (const line of patch.split('\n')) {
    const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line)
    if (m) {
      out.add(m[2]!)
    }
  }
  return [...out]
}

// ── Adapter real (I/O; coberto por E2E) ──────────────────────────────────────

export function defaultRestoreDeps(base: CheckpointDeps, cwd: string): RestoreDeps {
  return {
    ...base,
    applyPatch: (patch: string) => {
      execFileSync('git', ['apply', '--index', '--whitespace=nowarn'], {
        cwd,
        input: patch,
        stdio: ['pipe', 'ignore', 'pipe'],
      })
    },
  }
}
