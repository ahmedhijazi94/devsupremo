import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runSync, SYNC_STATE_FILE, type RemoteCheckpointInfo, type SyncDeps } from './sync'

/**
 * Sincronização entre máquinas (v3.3) — E2E REAL com git de verdade (não
 * fakes): duas MÁQUINAS reais (dois clones do mesmo remoto), provando o
 * cenário do pedido — "máquina A: A → B → C; máquina B está parada em A;
 * abre B, manda um prompt; Supremo atualiza A → C automaticamente se o
 * worktree estiver limpo" — e o oposto: trabalho local não-checkpointado
 * NUNCA é tocado.
 */

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function initRepo(cwd: string): void {
  git(cwd, ['init', '-q', '-b', 'main'])
  git(cwd, ['config', 'user.email', 'e2e@supremo.test'])
  git(cwd, ['config', 'user.name', 'Supremo Sync E2E'])
}

const REMOTE: RemoteCheckpointInfo = {
  id: 'cp-c',
  createdAt: '2026-01-03T00:00:00.000Z',
  summary: 'checkpoint C (publicado pela máquina A)',
  pushStatus: 'integrated',
  integrationStatus: 'merged',
  integrationBranch: null,
  publishedSha: null,
}

function realSyncDeps(cwd: string, fetchResult: Awaited<ReturnType<SyncDeps['fetchRemote']>>): SyncDeps {
  return {
    git: (args) => git(cwd, args),
    readQueue: () => [],
    readSyncedRemote: () => null,
    writeSyncedRemote: (state) => {
      const statePath = join(cwd, SYNC_STATE_FILE)
      mkdirSync(dirname(statePath), { recursive: true })
      writeFileSync(statePath, JSON.stringify(state))
    },
    fetchRemote: () => Promise.resolve(fetchResult),
  }
}

describe('sync — E2E real (git de verdade): "máquina A: A→B→C; máquina B parada em A" (v3.3)', () => {
  let remoteDir: string
  let machineA: string
  let machineB: string

  afterEach(() => {
    for (const d of [remoteDir, machineA, machineB]) {
      if (d) rmSync(d, { recursive: true, force: true })
    }
  })

  function setupTwoMachines(): void {
    // "GitHub": um bare repo real fazendo de remoto compartilhado.
    remoteDir = mkdtempSync(join(tmpdir(), 'supremo-sync-remote-'))
    git(remoteDir, ['init', '-q', '--bare', '-b', 'main'])

    // Máquina A: cria A, publica (push) — a "origem" de tudo.
    machineA = mkdtempSync(join(tmpdir(), 'supremo-sync-a-'))
    initRepo(machineA)
    writeFileSync(join(machineA, 'app.txt'), 'estado A\n')
    git(machineA, ['add', '-A'])
    git(machineA, ['commit', '-q', '-m', 'checkpoint: A'])
    git(machineA, ['remote', 'add', 'origin', remoteDir])
    git(machineA, ['push', '-q', 'origin', 'main'])

    // Máquina B: clona NESTE ponto (só conhece A) — "parada em A".
    machineB = mkdtempSync(join(tmpdir(), 'supremo-sync-b-'))
    git(tmpdir(), ['clone', '-q', remoteDir, machineB])
    git(machineB, ['config', 'user.email', 'e2e@supremo.test'])
    git(machineB, ['config', 'user.name', 'Supremo Sync E2E'])

    // Máquina A segue trabalhando SEM a máquina B saber: B, depois C. Publica os dois.
    writeFileSync(join(machineA, 'app.txt'), 'estado B\n')
    git(machineA, ['add', '-A'])
    git(machineA, ['commit', '-q', '-m', 'checkpoint: B'])
    writeFileSync(join(machineA, 'feature.txt'), 'novidade de C\n')
    git(machineA, ['add', '-A'])
    git(machineA, ['commit', '-q', '-m', 'checkpoint: C'])
    git(machineA, ['push', '-q', 'origin', 'main'])
  }

  it(
    'worktree LIMPO na máquina B → fast-forward automático até C (comportamento esperado do pedido)',
    async () => {
      setupTwoMachines()
      expect(readFileSync(join(machineB, 'app.txt'), 'utf8')).toBe('estado A\n') // ainda em A

      const outcome = await runSync(realSyncDeps(machineB, { ok: true, latest: REMOTE }))

      expect(outcome.action.kind).toBe('fast_forward')
      // Worktree da máquina B agora reflete C de verdade.
      expect(readFileSync(join(machineB, 'app.txt'), 'utf8')).toBe('estado B\n')
      expect(readFileSync(join(machineB, 'feature.txt'), 'utf8')).toBe('novidade de C\n')

      // Fast-forward de VERDADE: histórico LINEAR (sem merge commit), HEAD de B
      // agora é EXATAMENTE o HEAD de A — nunca um reset (reflog só tem "pull"/
      // "merge", nunca "reset").
      const headA = git(machineA, ['rev-parse', 'HEAD']).trim()
      const headB = git(machineB, ['rev-parse', 'HEAD']).trim()
      expect(headB).toBe(headA)
      const log = git(machineB, ['log', '--oneline'])
      expect(log.split('\n').filter(Boolean)).toHaveLength(3) // A, B, C — nunca um merge commit extra

      const state = JSON.parse(readFileSync(join(machineB, SYNC_STATE_FILE), 'utf8')) as {
        checkpointId: string
      }
      expect(state.checkpointId).toBe('cp-c')
    },
    20_000,
  )

  it(
    'worktree SUJO na máquina B → NUNCA sobrescreve; HEAD e a mudança local continuam intactos',
    async () => {
      setupTwoMachines()
      // Trabalho local NÃO checkpointado na máquina B.
      writeFileSync(join(machineB, 'app.txt'), 'rascunho local não salvo\n')

      const outcome = await runSync(realSyncDeps(machineB, { ok: true, latest: REMOTE }))

      expect(outcome.action.kind).toBe('diverged_dirty')
      // O rascunho continua EXATAMENTE como estava — nada foi tocado.
      expect(readFileSync(join(machineB, 'app.txt'), 'utf8')).toBe('rascunho local não salvo\n')
      // HEAD nunca avançou — nenhum fetch/merge rodou de verdade.
      const headA = git(machineA, ['rev-parse', 'HEAD']).trim()
      const headB = git(machineB, ['rev-parse', 'HEAD']).trim()
      expect(headB).not.toBe(headA)
      expect(git(machineB, ['status', '--porcelain']).trim()).not.toBe('') // ainda sujo, como o usuário deixou
    },
    20_000,
  )

  /**
   * REGRESSÃO ESPECÍFICA do ajuste pedido, com git de verdade: "Mac está em
   * A→B→C, checkpoint C já foi publicado, mas CI ainda está rodando. Abro o
   * notebook parado em A. Ele deve conseguir sincronizar com C e continuar
   * C→D, sem esperar o CI de C terminar." — C vive numa branch REAL própria
   * (nunca `main` — não mergeou ainda), exatamente como o Supremo publica de
   * verdade (Git Data API, `integration_branch`); `main` remoto SÓ tem A e B.
   */
  it(
    'C publicado numa branch própria (CI ainda rodando, NUNCA mergeado em main) → máquina nova sincroniza direto pra C mesmo assim',
    async () => {
      remoteDir = mkdtempSync(join(tmpdir(), 'supremo-sync-remote-'))
      git(remoteDir, ['init', '-q', '--bare', '-b', 'main'])

      machineA = mkdtempSync(join(tmpdir(), 'supremo-sync-a-'))
      initRepo(machineA)
      writeFileSync(join(machineA, 'app.txt'), 'estado A\n')
      git(machineA, ['add', '-A'])
      git(machineA, ['commit', '-q', '-m', 'checkpoint: A'])
      git(machineA, ['remote', 'add', 'origin', remoteDir])
      git(machineA, ['push', '-q', 'origin', 'main'])

      // Notebook clona EXATAMENTE aqui — "parado em A".
      machineB = mkdtempSync(join(tmpdir(), 'supremo-sync-b-'))
      git(tmpdir(), ['clone', '-q', remoteDir, machineB])
      git(machineB, ['config', 'user.email', 'e2e@supremo.test'])
      git(machineB, ['config', 'user.name', 'Supremo Sync E2E'])

      // B: já integrado numa sessão anterior (main remoto avança normalmente).
      writeFileSync(join(machineA, 'app.txt'), 'estado B\n')
      git(machineA, ['add', '-A'])
      git(machineA, ['commit', '-q', '-m', 'checkpoint: B'])
      git(machineA, ['push', '-q', 'origin', 'main'])

      // C: publicado pelo Supremo numa branch de integração PRÓPRIA — main
      // remoto continua SÓ com A+B (C não mergeou; CI "ainda rodando").
      writeFileSync(join(machineA, 'feature.txt'), 'novidade de C\n')
      git(machineA, ['add', '-A'])
      git(machineA, ['commit', '-q', '-m', 'checkpoint: C'])
      git(machineA, ['push', '-q', 'origin', 'HEAD:refs/heads/supremo/cp-c'])
      const mainAfterC = git(remoteDir, ['rev-parse', 'main']).trim()
      const cpCBranch = git(remoteDir, ['rev-parse', 'supremo/cp-c']).trim()
      expect(mainAfterC).not.toBe(cpCBranch) // C NÃO está em main — prova que a branch é mesmo separada

      const checkpointC: RemoteCheckpointInfo = {
        id: 'cp-c',
        createdAt: '2026-01-03T00:00:00.000Z',
        summary: 'checkpoint C',
        pushStatus: 'published', // publicado com sucesso — nunca "failed"/estado arbitrário
        integrationStatus: 'ci_running', // CI ainda rodando — NUNCA mergeado
        integrationBranch: 'supremo/cp-c',
        publishedSha: cpCBranch, // SHA exato que o publish gravou pra este checkpoint
      }

      const outcome = await runSync(realSyncDeps(machineB, { ok: true, latest: checkpointC }))

      expect(outcome.action.kind).toBe('fast_forward')
      // O notebook chegou em C de verdade — SEM esperar main/CI.
      expect(readFileSync(join(machineB, 'app.txt'), 'utf8')).toBe('estado B\n')
      expect(readFileSync(join(machineB, 'feature.txt'), 'utf8')).toBe('novidade de C\n')
      expect(git(machineB, ['rev-parse', 'HEAD']).trim()).toBe(cpCBranch)
      // Nunca tocou em main (nem fetch, nem merge de main) — só a branch de C.
      expect(git(machineB, ['log', '--oneline'])).not.toContain('refs/heads/main')

      // D (o próximo checkpoint da máquina nova) nasce baseado em C.
      const state = JSON.parse(readFileSync(join(machineB, SYNC_STATE_FILE), 'utf8')) as {
        checkpointId: string
      }
      expect(state.checkpointId).toBe('cp-c')
    },
    20_000,
  )

  /**
   * REGRESSÃO ESPECÍFICA (item 2 do ajuste) — race real, com git de verdade:
   * sync-status informa o checkpoint C (com seu `published_sha` exato).
   * ENQUANTO a máquina B sincroniza (fetch/merge), a máquina A publica D na
   * MESMA `integration_branch` (ela segue aberta — PR/CI em andamento). O
   * `git fetch` de B necessariamente traz D também (é o novo tip da
   * branch), mas o `merge --ff-only` deste comando SEMPRE mira o
   * `published_sha` exato de C — nunca `origin/<branch>` — então B pousa
   * EXATAMENTE em C, nunca em D, e o estado sincronizado gravado
   * corresponde ao HEAD real (nunca um "head arbitrário/não confirmado").
   */
  it(
    'RACE: outra máquina publica D na MESMA integration_branch enquanto B sincroniza → B pousa EXATAMENTE em C (published_sha), nunca em D',
    async () => {
      remoteDir = mkdtempSync(join(tmpdir(), 'supremo-sync-remote-'))
      git(remoteDir, ['init', '-q', '--bare', '-b', 'main'])

      machineA = mkdtempSync(join(tmpdir(), 'supremo-sync-a-'))
      initRepo(machineA)
      writeFileSync(join(machineA, 'app.txt'), 'estado A\n')
      git(machineA, ['add', '-A'])
      git(machineA, ['commit', '-q', '-m', 'checkpoint: A'])
      git(machineA, ['remote', 'add', 'origin', remoteDir])
      git(machineA, ['push', '-q', 'origin', 'main'])

      machineB = mkdtempSync(join(tmpdir(), 'supremo-sync-b-'))
      git(tmpdir(), ['clone', '-q', remoteDir, machineB])
      git(machineB, ['config', 'user.email', 'e2e@supremo.test'])
      git(machineB, ['config', 'user.name', 'Supremo Sync E2E'])

      writeFileSync(join(machineA, 'app.txt'), 'estado B\n')
      git(machineA, ['add', '-A'])
      git(machineA, ['commit', '-q', '-m', 'checkpoint: B'])
      git(machineA, ['push', '-q', 'origin', 'main'])

      // C: publicado numa branch de integração própria.
      writeFileSync(join(machineA, 'feature.txt'), 'novidade de C\n')
      git(machineA, ['add', '-A'])
      git(machineA, ['commit', '-q', '-m', 'checkpoint: C'])
      git(machineA, ['push', '-q', 'origin', 'HEAD:refs/heads/supremo/cp-c'])
      const cSha = git(remoteDir, ['rev-parse', 'supremo/cp-c']).trim()

      // sync-status de B captura o estado de C AGORA — este é o published_sha
      // exato que B vai carregar consigo até o fetch/merge.
      const checkpointC: RemoteCheckpointInfo = {
        id: 'cp-c',
        createdAt: '2026-01-03T00:00:00.000Z',
        summary: 'checkpoint C',
        pushStatus: 'published',
        integrationStatus: 'ci_running',
        integrationBranch: 'supremo/cp-c',
        publishedSha: cSha,
      }

      // RACE: a máquina A publica D na MESMA branch — supremo/cp-c avança —
      // ANTES de B efetivamente fazer o fetch/merge com a info acima.
      writeFileSync(join(machineA, 'other.txt'), 'chegou D no meio da corrida\n')
      git(machineA, ['add', '-A'])
      git(machineA, ['commit', '-q', '-m', 'checkpoint: D'])
      git(machineA, ['push', '-q', 'origin', 'HEAD:refs/heads/supremo/cp-c'])
      const dSha = git(remoteDir, ['rev-parse', 'supremo/cp-c']).trim()
      expect(dSha).not.toBe(cSha) // a branch realmente avançou pra D

      const outcome = await runSync(realSyncDeps(machineB, { ok: true, latest: checkpointC }))

      expect(outcome.action.kind).toBe('fast_forward')
      // B pousa EXATAMENTE em C — nunca em D, mesmo o fetch tendo trazido D
      // também (D é filho de C na mesma branch, então chega junto no fetch).
      const headB = git(machineB, ['rev-parse', 'HEAD']).trim()
      expect(headB).toBe(cSha)
      expect(headB).not.toBe(dSha)
      expect(readFileSync(join(machineB, 'feature.txt'), 'utf8')).toBe('novidade de C\n')
      // D nunca chega no worktree de B.
      expect(() => readFileSync(join(machineB, 'other.txt'), 'utf8')).toThrow()

      // O estado sincronizado gravado corresponde EXATAMENTE ao HEAD real —
      // nunca um head arbitrário/não confirmado.
      const state = JSON.parse(readFileSync(join(machineB, SYNC_STATE_FILE), 'utf8')) as {
        checkpointId: string
      }
      expect(state.checkpointId).toBe('cp-c')
    },
    20_000,
  )
})
