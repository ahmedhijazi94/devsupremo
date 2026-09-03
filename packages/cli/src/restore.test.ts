import { describe, expect, it } from 'vitest'
import type { CheckpointDeps, CheckpointRecord } from './checkpoint'
import {
  applyRestore,
  findLocalCommitForCheckpoint,
  isEmptyPatch,
  restoreCommitMessage,
  RestoreTargetNotFoundLocallyError,
  type RestoreDeps,
} from './restore'

const record = (over: Partial<CheckpointRecord> = {}): CheckpointRecord => ({
  checkpointId: 'cpB',
  projectId: 'proj-1',
  commitSha: 'sha-B',
  parentCheckpointId: null,
  createdAt: 't',
  summary: 'deixar home minimalista',
  riskLevel: 'low',
  migrations: [],
  changedPaths: [],
  pushStatus: 'published',
  attempts: 0,
  ...over,
})

describe('puro', () => {
  it('findLocalCommitForCheckpoint — acha pelo checkpointId', () => {
    const queue = [record({ checkpointId: 'cpA', commitSha: 'sha-A' }), record()]
    expect(findLocalCommitForCheckpoint(queue, 'cpB')).toBe('sha-B')
    expect(findLocalCommitForCheckpoint(queue, 'cp-inexistente')).toBeNull()
  })

  it('isEmptyPatch', () => {
    expect(isEmptyPatch('')).toBe(true)
    expect(isEmptyPatch('   \n')).toBe(true)
    expect(isEmptyPatch('diff --git a/x b/x\n...')).toBe(false)
  })

  it('restoreCommitMessage', () => {
    expect(restoreCommitMessage('deixar home minimalista')).toBe(
      'checkpoint: Restaurar "deixar home minimalista"',
    )
  })
})

// ── Fakes injetáveis ─────────────────────────────────────────────────────────

function fakeDeps(opts: {
  queue: CheckpointRecord[]
  porcelain?: string
  diff?: string
  shas?: string[] // sequência de rev-parse HEAD
}): { deps: RestoreDeps; calls: string[][]; queue: CheckpointRecord[]; applied: string[] } {
  const calls: string[][] = []
  const queue = [...opts.queue]
  const applied: string[] = []
  let shaIdx = 0
  let uuidCounter = 0
  const shas = opts.shas ?? ['head-current', 'new-sha']

  const base: CheckpointDeps = {
    git: (args) => {
      calls.push(args)
      if (args[0] === 'status') return opts.porcelain ?? ''
      if (args[0] === 'rev-parse') return `${shas[shaIdx++] ?? 'sha-x'}\n`
      if (args[0] === 'diff') return opts.diff ?? ''
      return ''
    },
    readQueue: () => [...queue],
    appendQueue: (r) => queue.push(r),
    notifyDaemon: () => {},
    now: () => '2026-09-02T00:00:00.000Z',
    uuid: () => `uuid-${++uuidCounter}`,
  }
  const deps: RestoreDeps = {
    ...base,
    applyPatch: (patch) => {
      applied.push(patch)
    },
  }
  return { deps, calls, queue, applied }
}

describe('applyRestore', () => {
  it('alvo não existe no histórico local desta máquina → lança (restore é por-máquina)', () => {
    const { deps } = fakeDeps({ queue: [] })
    expect(() => applyRestore('cp-inexistente', 'x', 'proj-1', deps)).toThrow(
      RestoreTargetNotFoundLocallyError,
    )
  })

  it('worktree já igual ao alvo (diff vazio) → não cria checkpoint', () => {
    const { deps, applied, queue } = fakeDeps({
      queue: [record()],
      diff: '',
    })
    const before = queue.length
    const out = applyRestore('cpB', 'deixar home minimalista', 'proj-1', deps)
    expect(out).toEqual({ applied: false, record: null })
    expect(applied).toHaveLength(0)
    expect(queue.length).toBe(before) // nada novo enfileirado
  })

  it('restaura com sucesso: aplica o patch e cria o checkpoint E (testes 39-41)', () => {
    const { deps, applied, calls } = fakeDeps({
      queue: [record()],
      diff: 'diff --git a/app/page.tsx b/app/page.tsx\n@@ ...',
      shas: ['head-atual', 'novo-sha-E'],
    })
    const out = applyRestore('cpB', 'deixar home minimalista', 'proj-1', deps)
    expect(out.applied).toBe(true)
    expect(out.record?.commitSha).toBe('novo-sha-E')
    expect(out.record?.restoredFromCheckpointId).toBe('cpB')
    expect(out.record?.summary).toContain('Restaurar')
    // aplicou o patch correto (não fez reset/checkout destrutivo)
    expect(applied).toEqual(['diff --git a/app/page.tsx b/app/page.tsx\n@@ ...'])
    // nenhuma operação destrutiva de histórico
    expect(calls.flat()).not.toContain('reset')
    expect(calls.flat()).not.toContain('checkout')
  })

  it('worktree sujo → salvaguarda automática ANTES de restaurar (nunca perde trabalho)', () => {
    const { deps, queue } = fakeDeps({
      queue: [record()],
      porcelain: ' M app/dirty.ts\n',
      diff: 'diff --git a/x b/x\n@@ ...',
      shas: ['sha-salvaguarda', 'head-atual', 'novo-sha-E'],
    })
    const out = applyRestore('cpB', 'x', 'proj-1', deps)
    expect(out.applied).toBe(true)
    // a salvaguarda entrou na fila ANTES do checkpoint de restore
    const summaries = queue.map((r) => r.summary)
    expect(summaries.some((s) => s.includes('Salvaguarda automática'))).toBe(true)
  })

  /**
   * E2E real: o daemon recebeu o pedido de restore, aplicou o patch no
   * worktree (visível via HMR), mas a operação parou aí — nenhum commit,
   * nenhum checkpoint novo, `git status` continuava com a mudança pendente.
   * Causa: o `git commit` do restore (e da salvaguarda) roda por trás do
   * hook LOCAL `.githooks/pre-commit` (gerado pelo scaffold — `verify.mjs
   * --staged`, que pode incluir build) — se esse hook travar/falhar por uma
   * limitação AMBIENTAL do sandbox, o daemon (headless, sem timeout, sem
   * ninguém pra perceber) trava PRA SEMPRE dentro do commit. Fix: os dois
   * commits deste fluxo usam `--no-verify` — pulam o hook local (só DX; a CI
   * no servidor continua sendo a barreira real, inalterada).
   */
  describe('--no-verify: o hook LOCAL nunca pode travar o restore (testes 42-44)', () => {
    it('o commit do checkpoint E (restore) usa --no-verify — pula o hook local que pode travar por limitação de sandbox', () => {
      const { deps, calls } = fakeDeps({
        queue: [record()],
        diff: 'diff --git a/app/page.tsx b/app/page.tsx\n@@ ...',
        shas: ['head-atual', 'novo-sha-E'],
      })
      applyRestore('cpB', 'deixar home minimalista', 'proj-1', deps)
      const commitCalls = calls.filter((c) => c[0] === 'commit')
      expect(commitCalls).toHaveLength(1)
      expect(commitCalls[0]).toContain('--no-verify')
    })

    it('o commit da salvaguarda automática TAMBÉM usa --no-verify — a garantia "nunca perde trabalho" não pode ficar refém do mesmo hook', () => {
      const { deps, calls } = fakeDeps({
        queue: [record()],
        porcelain: ' M app/dirty.ts\n',
        diff: 'diff --git a/x b/x\n@@ ...',
        shas: ['sha-salvaguarda', 'head-atual', 'novo-sha-E'],
      })
      applyRestore('cpB', 'x', 'proj-1', deps)
      const commitCalls = calls.filter((c) => c[0] === 'commit')
      expect(commitCalls).toHaveLength(2) // salvaguarda + E
      for (const call of commitCalls) {
        expect(call).toContain('--no-verify')
      }
    })
  })
})
