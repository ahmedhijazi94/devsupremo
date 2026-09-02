import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildCheckpointRecord,
  classifyCheckpointRisk,
  detectMigrations,
  hasChanges,
  nextParentId,
  NothingToCheckpointError,
  parseChangedPaths,
  runCheckpoint,
  type CheckpointDeps,
  type CheckpointRecord,
} from './checkpoint'

// ── Fake git + deps injetáveis (sem repo/rede reais) ─────────────────────────

function makeDeps(porcelain: string, shas: string[]) {
  const calls: string[][] = []
  const queue: CheckpointRecord[] = []
  let notified = 0
  let n = 0
  let counter = 0
  const deps: CheckpointDeps = {
    git: (args) => {
      calls.push(args)
      if (args[0] === 'status') return porcelain
      if (args[0] === 'rev-parse') return (shas[n++] ?? 'sha0') + '\n'
      return ''
    },
    readQueue: () => [...queue],
    appendQueue: (r) => queue.push(r),
    notifyDaemon: () => {
      notified++
    },
    now: () => '2026-09-02T00:00:00.000Z',
    uuid: () => `uuid-${++counter}`,
  }
  return { deps, calls, queue, notified: () => notified }
}

describe('checkpoint puro', () => {
  it('hasChanges', () => {
    expect(hasChanges('')).toBe(false)
    expect(hasChanges('   \n')).toBe(false)
    expect(hasChanges(' M a.ts\n')).toBe(true)
  })

  it('parseChangedPaths (inclui rename)', () => {
    const p = ' M app/page.tsx\n?? new.ts\nR  old.ts -> app/api/x/route.ts\n'
    expect(parseChangedPaths(p)).toEqual(['app/page.tsx', 'new.ts', 'app/api/x/route.ts'])
  })

  it('classifyCheckpointRisk', () => {
    expect(classifyCheckpointRisk(['app/globals.css'])).toBe('low')
    expect(classifyCheckpointRisk(['src/lib/util.ts'])).toBe('medium')
    expect(classifyCheckpointRisk(['app/api/orders/route.ts'])).toBe('high')
    expect(classifyCheckpointRisk(['supabase/migrations/1.sql'])).toBe('high')
    expect(classifyCheckpointRisk(['.github/workflows/ci.yml'])).toBe('high')
    expect(classifyCheckpointRisk(Array.from({ length: 9 }, (_, i) => `c${i}.tsx`))).toBe(
      'medium',
    )
  })

  it('detectMigrations', () => {
    expect(detectMigrations(['supabase/migrations/016_x.sql', 'app/page.tsx'])).toEqual([
      'supabase/migrations/016_x.sql',
    ])
  })

  it('nextParentId', () => {
    expect(nextParentId([])).toBeNull()
    expect(
      nextParentId([buildCheckpointRecord({
        checkpointId: 'c1', projectId: 'p', commitSha: 's', parentCheckpointId: null,
        createdAt: 't', summary: 'x', changedPaths: [],
      })]),
    ).toBe('c1')
  })
})

describe('runCheckpoint — LOCAL, sem rede (testes 1, 2)', () => {
  it('cria commit local, enfileira e retorna sem push nem rede', () => {
    const { deps, calls, queue, notified } = makeDeps(' M app/page.tsx\n', ['abcdef1'])
    const rec = runCheckpoint('home minimalista', 'proj-1', deps)

    // Só operações git LOCAIS — jamais push/fetch/remote.
    const verbs = calls.map((c) => c[0])
    expect(verbs).toEqual(['status', 'add', 'commit', 'rev-parse'])
    expect(calls.flat()).not.toContain('push')
    expect(calls.flat()).not.toContain('fetch')

    // Retorna imediatamente com o checkpoint em estado LOCAL (nada empurrado).
    expect(rec.pushStatus).toBe('local')
    expect(rec.commitSha).toBe('abcdef1')
    expect(rec.projectId).toBe('proj-1')
    expect(queue).toHaveLength(1)
    expect(notified()).toBe(1)
  })

  it('nada mudou → NothingToCheckpointError (não cria commit)', () => {
    const { deps, calls } = makeDeps('', [])
    expect(() => runCheckpoint('x', 'p', deps)).toThrow(NothingToCheckpointError)
    expect(calls.map((c) => c[0])).toEqual(['status'])
  })

  it('dois checkpoints em sequência mantêm ORDEM e linkagem de parent (teste 15)', () => {
    const calls: string[][] = []
    const queue: CheckpointRecord[] = []
    let sha = 0
    let id = 0
    const deps: CheckpointDeps = {
      git: (args) => {
        calls.push(args)
        if (args[0] === 'status') return ' M a.ts\n'
        if (args[0] === 'rev-parse') return `sha${++sha}\n`
        return ''
      },
      readQueue: () => [...queue],
      appendQueue: (r) => queue.push(r),
      notifyDaemon: () => {},
      now: () => 't',
      uuid: () => `cp${++id}`,
    }
    const a = runCheckpoint('A', 'p', deps)
    const b = runCheckpoint('B', 'p', deps)
    expect(queue.map((r) => r.checkpointId)).toEqual(['cp1', 'cp2'])
    expect(a.parentCheckpointId).toBeNull()
    expect(b.parentCheckpointId).toBe('cp1')
  })
})

describe('checkpoint não interfere no preview (teste 19)', () => {
  it('o código do checkpoint não fala com rede nem mexe no preview', () => {
    const src = readFileSync(join(__dirname, 'checkpoint.ts'), 'utf8')
    expect(src).not.toContain('fetch(')
    expect(src).not.toContain('preview.pid')
    expect(src).not.toContain('preview:stop')
  })
})
