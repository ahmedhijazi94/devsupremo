import fs from 'node:fs'
import path from 'node:path'
import { hasChanges, CHECKPOINT_DIR, type CheckpointDeps, type CheckpointRecord } from './checkpoint'

/**
 * Sincronização automática entre máquinas (v3.3) — sem `git pull` manual.
 *
 * Objetivo de UX: trabalhar num projeto no PC, fechar, abrir o mesmo projeto
 * no notebook e simplesmente mandar o próximo prompt — o Supremo percebe se
 * aquela máquina está atrasada e sincroniza sozinho.
 *
 * Roda UMA vez por sessão (primeiro pedido, depois de `supremo:resume` já ter
 * garantido daemon/preview — ver AGENTS.md "Retomada automática de sessão").
 * LEVE de propósito: um SELECT no backend (nunca GitHub), timeout curto (nunca
 * trava a sessão), e nenhum build/teste/install/bootstrap.
 *
 * A verdade final NUNCA é o worktree local nem só `origin/main` — é o
 * checkpoint mais recente CONHECIDO do projeto (reaproveita `checkpoints` e
 * `parent_checkpoint_id`, já existentes; ver `/api/checkpoint/sync-status` e
 * `baseCheckpointIsFresh` no backend). A CONTINUIDADE de edição entre
 * máquinas NUNCA espera o CI: um checkpoint já PUBLICADO com sucesso pelo
 * Supremo (uma branch real, gerenciada pelo backend — `integration_branch`,
 * já existente) já é uma base válida, mesmo com PR/CI ainda rodando —
 * `main`/merge continuam exigindo CI verde, isto é só o worktree local
 * alcançando o que o Supremo já publicou de verdade. Fast-forward só quando
 * é SEGURO: `--ff-only` (nunca reset/force) sobre uma branch REAL já
 * gerenciada pelo Supremo (nunca estado arbitrário/não publicado), e só se o
 * worktree estiver limpo. Trabalho local não-checkpointado NUNCA é tocado —
 * a consistência final é garantida no PUBLISH (proteção cross-machine no
 * backend), não aqui.
 */

export const SYNC_STATE_FILE = `${CHECKPOINT_DIR}/synced-remote.json`

export interface SyncedRemoteState {
  checkpointId: string
  createdAt: string
  checkedAt: string
}

/** O checkpoint mais recente conhecido do projeto, segundo o backend. */
export interface RemoteCheckpointInfo {
  id: string
  createdAt: string
  summary: string
  pushStatus: string
  integrationStatus: string | null
  /** Branch de integração REAL já gerenciada pelo Supremo (Git Data API) —
   * existe assim que `pushStatus` chega a 'published'. `null` enquanto ainda
   * está 'publishing' (nenhuma branch confirmada ainda). */
  integrationBranch: string | null
  /** SHA EXATO que este checkpoint produziu em `integrationBranch` (Git Data
   * API, já gravado no publish — coluna existente). `integrationBranch`
   * continua ABERTA (PR/CI em andamento) e pode ganhar um checkpoint NOVO de
   * OUTRA máquina entre esta consulta e o `fetch` — pinar neste SHA (em vez
   * de seguir o tip móvel da branch) garante que o fast-forward só pode
   * pousar EXATAMENTE neste checkpoint, nunca num commit mais novo que
   * chegou durante a corrida. `null` enquanto ainda 'publishing'. */
  publishedSha: string | null
}

// ── Puro ─────────────────────────────────────────────────────────────────────

/**
 * A base que o PRÓXIMO checkpoint desta máquina deveria declarar como
 * `parentCheckpointId` — o mais recente entre o último checkpoint LOCAL desta
 * máquina (fila) e o último estado remoto CONFIRMADAMENTE sincronizado (só
 * gravado depois de um fast-forward bem-sucedido — ver `runSync`). Comparação
 * por `createdAt`: um checkpoint novo criado NESTA sessão é sempre mais
 * recente que o registro da sincronização que o precedeu, então a fila local
 * volta a ganhar naturalmente sem precisar invalidar nada à mão.
 */
export function resolveParentCheckpointId(
  queue: readonly Pick<CheckpointRecord, 'checkpointId' | 'createdAt'>[],
  syncedRemote: SyncedRemoteState | null,
): string | null {
  const localLast = queue.length > 0 ? queue[queue.length - 1]! : null
  if (!syncedRemote) return localLast?.checkpointId ?? null
  if (!localLast) return syncedRemote.checkpointId
  return new Date(syncedRemote.createdAt).getTime() > new Date(localLast.createdAt).getTime()
    ? syncedRemote.checkpointId
    : localLast.checkpointId
}

export type SyncAction =
  | { kind: 'up_to_date' }
  | { kind: 'fast_forward'; target: RemoteCheckpointInfo; branch: string; pinnedSha: string | null }
  | { kind: 'diverged_dirty'; target: RemoteCheckpointInfo }
  | { kind: 'ahead_publishing'; target: RemoteCheckpointInfo }
  | { kind: 'unreachable' }

/**
 * A branch REAL (já gerenciada pelo Supremo, via Git Data API) que reflete
 * este checkpoint, e — quando aplicável — o SHA exato em que o fast-forward
 * deve pousar (nunca estado arbitrário/não publicado):
 *   - já INTEGRADO (mergeado) → `{ branch: 'main', pinnedSha: null }` — segue
 *     o tip real de `main`, a fonte canônica; `main` só avança por merge
 *     protegido/CI-gated, então não sofre a corrida abaixo — qualquer commit
 *     que chegue lá nesse meio-tempo já é, por construção, publicado e válido;
 *   - PUBLICADO mas ainda NÃO integrado (branch real existe; PR/CI podem
 *     estar rodando) → `{ branch: integrationBranch, pinnedSha: publishedSha }`
 *     — é a continuidade de edição que o pedido exige (CI segue obrigatório
 *     só pra MERGE), MAS essa branch continua ABERTA: outra máquina pode
 *     publicar um checkpoint NOVO nela entre esta consulta e o `fetch` do
 *     comando `sync`. Pinar no `publishedSha` EXATO deste checkpoint (Git
 *     Data API, já gravado no publish) garante que o `merge --ff-only`
 *     pousa EXATAMENTE aqui, nunca num commit mais novo que chegou durante
 *     a corrida — sem isso, `publishedSha` ausente (defensivo: nunca deveria
 *     acontecer, mas nunca se arrisca) também cai em "nada seguro ainda";
 *   - ainda 'publishing' (nenhuma branch confirmada) ou 'failed' → `null`,
 *     não há nada seguro pra puxar ainda.
 */
function syncTarget(remote: RemoteCheckpointInfo): { branch: string; pinnedSha: string | null } | null {
  if (remote.pushStatus === 'integrated' || remote.integrationStatus === 'merged') {
    return { branch: 'main', pinnedSha: null }
  }
  if (remote.pushStatus === 'published' && remote.integrationBranch && remote.publishedSha) {
    return { branch: remote.integrationBranch, pinnedSha: remote.publishedSha }
  }
  return null
}

/**
 * Decisão PURA — dados os fatos já observados (nunca decide git/rede
 * sozinha), o que fazer:
 *   - remoto inalcançável (timeout/rede) → segue local, sem arriscar nada;
 *   - igual → nada a fazer;
 *   - atrás + worktree sujo → NUNCA sobrescreve, só reconhece a divergência;
 *   - atrás + o backend ainda não confirmou nenhuma branch/SHA seguro
 *     (publishing/failed, ou published sem publishedSha) → reconhece que
 *     existe algo mais novo, mas não há nada seguro pra puxar ainda;
 *   - atrás + limpo + já publicado (integrado OU só com PR/CI em andamento)
 *     → fast-forward automático pra branch/SHA REAL correspondente.
 */
export function planSync(input: {
  localCheckpointId: string | null
  remote: RemoteCheckpointInfo | null
  worktreeClean: boolean
  remoteReachable: boolean
}): SyncAction {
  if (!input.remoteReachable) return { kind: 'unreachable' }
  if (input.remote === null || input.remote.id === input.localCheckpointId) {
    return { kind: 'up_to_date' }
  }
  if (!input.worktreeClean) return { kind: 'diverged_dirty', target: input.remote }
  const target = syncTarget(input.remote)
  if (!target) return { kind: 'ahead_publishing', target: input.remote }
  return { kind: 'fast_forward', target: input.remote, branch: target.branch, pinnedSha: target.pinnedSha }
}

// ── Orquestração (I/O injetável) ─────────────────────────────────────────────

export interface SyncDeps extends Pick<CheckpointDeps, 'git' | 'readQueue'> {
  readSyncedRemote: () => SyncedRemoteState | null
  writeSyncedRemote: (state: SyncedRemoteState) => void
  /** Timeout/rede tratados aqui — `ok:false` nunca lança, só sinaliza "não deu
   * pra saber" (a sessão nunca fica esperando por causa disto). */
  fetchRemote: () => Promise<{ ok: true; latest: RemoteCheckpointInfo | null } | { ok: false }>
}

export interface SyncOutcome {
  action: SyncAction
  message: string
}

export async function runSync(deps: SyncDeps): Promise<SyncOutcome> {
  const queue = deps.readQueue()
  const syncedRemote = deps.readSyncedRemote()
  const localCheckpointId = resolveParentCheckpointId(queue, syncedRemote)

  const result = await deps.fetchRemote()
  const porcelain = deps.git(['status', '--porcelain'])
  const worktreeClean = !hasChanges(porcelain)

  const action = planSync({
    localCheckpointId,
    remote: result.ok ? result.latest : null,
    worktreeClean,
    remoteReachable: result.ok,
  })

  const nowIso = () => new Date().toISOString()

  switch (action.kind) {
    case 'unreachable':
      return { action, message: 'sync remoto indisponível (timeout/rede) — seguindo com o estado local.' }

    case 'up_to_date':
      if (result.ok && result.latest) {
        deps.writeSyncedRemote({
          checkpointId: result.latest.id,
          createdAt: result.latest.createdAt,
          checkedAt: nowIso(),
        })
      }
      return { action, message: 'já sincronizado com o estado mais recente conhecido.' }

    case 'diverged_dirty':
      return {
        action,
        message: `existe um checkpoint mais novo publicado ("${action.target.summary}") e este worktree tem alterações não salvas — nada foi sobrescrito. Feche o pedido com um checkpoint normal e a sincronização segue no próximo.`,
      }

    case 'ahead_publishing':
      return {
        action,
        message: `existe um checkpoint mais novo ("${action.target.summary}") ainda sendo publicado pelo Supremo — sincroniza sozinho assim que a branch ficar disponível.`,
      }

    case 'fast_forward': {
      try {
        deps.git(['fetch', 'origin', action.branch])
        // Pinado (checkpoint publicado, branch ainda aberta) → mergeia
        // EXATAMENTE nesse SHA, nunca no tip da branch (que pode ter
        // avançado pra um checkpoint mais novo de outra máquina entre a
        // consulta e este fetch — ver `syncTarget`). Sem pin (já integrado
        // → `main`) → segue o tip real, que é a fonte canônica ali.
        deps.git(['merge', '--ff-only', action.pinnedSha ?? `origin/${action.branch}`])
      } catch {
        return {
          action,
          message: 'não foi possível sincronizar automaticamente (fast-forward indisponível) — nada foi alterado; sincronize manualmente quando puder.',
        }
      }
      deps.writeSyncedRemote({
        checkpointId: action.target.id,
        createdAt: action.target.createdAt,
        checkedAt: nowIso(),
      })
      return { action, message: `sincronizado automaticamente com "${action.target.summary}".` }
    }
  }
}

// ── Adapter real (I/O; coberto por E2E) ──────────────────────────────────────

/** Só leitura — usado tanto pelo comando `sync` quanto por `checkpoint` (pra
 * resolver o `parentCheckpointId` do PRÓXIMO checkpoint; ver bin.ts). Nunca
 * faz rede: `runSync` é o único que ESCREVE este arquivo. */
export function readSyncedRemoteState(cwd: string): SyncedRemoteState | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(cwd, SYNC_STATE_FILE), 'utf8')) as SyncedRemoteState
  } catch {
    return null
  }
}

export function defaultSyncDeps(
  base: Pick<CheckpointDeps, 'git' | 'readQueue'>,
  cwd: string,
  fetchRemote: SyncDeps['fetchRemote'],
): SyncDeps {
  const statePath = path.join(cwd, SYNC_STATE_FILE)
  return {
    ...base,
    fetchRemote,
    readSyncedRemote: () => readSyncedRemoteState(cwd),
    writeSyncedRemote: (state) => {
      fs.mkdirSync(path.dirname(statePath), { recursive: true })
      fs.writeFileSync(statePath, JSON.stringify(state))
    },
  }
}
