import { describe, expect, it } from 'vitest'
import {
  buildChangeset,
  computeChangesetSha256,
  sha256Hex,
  type Changeset,
  type CommitReader,
} from './changeset'
import type { CheckpointRecord } from './checkpoint'

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64')

describe('computeChangesetSha256 — paridade com o backend', () => {
  it('golden idêntico ao backend (não muda sem atualizar ambos)', () => {
    const cs: Changeset = {
      checkpointId: '11111111-1111-1111-1111-111111111111',
      commitSha: 'abcdef1234567',
      parentCheckpointId: null,
      message: 'checkpoint: x',
      authorName: 'Dev',
      authorEmail: 'd@e.co',
      files: [
        { path: 'b.ts', op: 'add', contentBase64: b64('b'), sha256: 'x'.repeat(64), mode: '100644' },
        { path: 'a.ts', op: 'delete' },
      ],
    }
    expect(computeChangesetSha256(cs)).toBe(
      'f7b689b91396a36d617e8bb634f876a3d861cc25f9a88e7615deafe482adcb6e',
    )
  })
})

describe('buildChangeset — binário, delete e rename', () => {
  const record: CheckpointRecord = {
    checkpointId: 'cp1',
    projectId: 'p',
    commitSha: 'sha-B',
    parentCheckpointId: 'cp0',
    createdAt: 't',
    summary: 's',
    riskLevel: 'low',
    migrations: [],
    changedPaths: [],
    pushStatus: 'local',
    attempts: 0,
  }
  const reader: CommitReader = {
    changes: () => [
      { status: 'M', path: 'app/page.tsx' },
      { status: 'A', path: 'public/logo.png' },
      { status: 'D', path: 'old.ts' },
      { status: 'R100', path: 'b.ts', oldPath: 'a.ts' },
    ],
    content: (_s, path) => {
      if (path === 'old.ts') return null
      if (path === 'public/logo.png') return Buffer.from([0, 255, 10, 13])
      return Buffer.from('x:' + path, 'utf8')
    },
    meta: () => ({ message: 'm', authorName: 'n', authorEmail: 'e' }),
    executable: () => false,
  }

  it('produz ops corretas e preserva binário + sha256', () => {
    const cs = buildChangeset(record, reader)
    const png = cs.files.find((f) => f.path === 'public/logo.png')!
    expect(png.op).toBe('add')
    expect(Buffer.from(png.contentBase64!, 'base64')).toEqual(Buffer.from([0, 255, 10, 13]))
    expect(png.sha256).toBe(sha256Hex(Buffer.from([0, 255, 10, 13])))

    expect(cs.files.some((f) => f.path === 'old.ts' && f.op === 'delete')).toBe(true)
    expect(cs.files.some((f) => f.path === 'a.ts' && f.op === 'delete')).toBe(true)
    expect(cs.files.some((f) => f.path === 'b.ts' && f.op === 'add')).toBe(true)
    expect(cs.parentCheckpointId).toBe('cp0')
    // o SHA do changeset é estável
    expect(computeChangesetSha256(cs)).toHaveLength(64)
  })
})
