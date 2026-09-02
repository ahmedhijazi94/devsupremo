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
})
