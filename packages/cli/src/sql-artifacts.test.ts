import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SqlArtifact } from '../../../src/lib/sql-artifacts/contract'
import { artifactDigest } from '../../../src/lib/sql-artifacts/service'
import { materializeSqlFile, sqlArtifactTick, type SqlArtifactClient } from './sql-artifacts'
import { gitText, writeJson } from './turn-workspace'
import { defaultCheckpointDeps } from './checkpoint'

let cwd: string
const content = 'create index note_index on public.notes(id);'
const file = 'supabase/migrations/20261005123456_11111111111141118111111111111111.sql'
beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'supremo-sql-artifact-'))
  gitText(cwd, ['init', '-b', 'main']); gitText(cwd, ['config', 'user.name', 'Fixture']); gitText(cwd, ['config', 'user.email', 'test@example.invalid'])
  fs.writeFileSync(path.join(cwd, '.gitignore'), '.supremo/\n'); fs.writeFileSync(path.join(cwd, 'app.txt'), 'preview source\n')
  gitText(cwd, ['add', '.']); gitText(cwd, ['commit', '-m', 'base'])
})
afterEach(() => fs.rmSync(cwd, { recursive: true, force: true }))
const sample = (): SqlArtifact => ({ id: '11111111-1111-4111-8111-111111111111', projectId: '22222222-2222-4222-8222-222222222222', environment: 'development', projectRef: 'example',
  path: file, content, digest: artifactDigest(content), state: 'materializing', claimToken: '33333333-3333-4333-8333-333333333333', types: null, message: '', updatedAt: new Date().toISOString() })
it('materializes only immutable matching files and refuses symlinks, paths and version collisions', () => {
  materializeSqlFile(cwd, file, content, artifactDigest(content)); materializeSqlFile(cwd, file, content, artifactDigest(content))
  expect(() => materializeSqlFile(cwd, file, 'changed', artifactDigest('changed'))).toThrow('divergente')
  expect(() => materializeSqlFile(cwd, '../outside.sql', content, artifactDigest(content))).toThrow('Caminho')
  expect(() => materializeSqlFile(cwd, file.replace(/1{8}/, '2'.repeat(8)), content, artifactDigest(content))).toThrow('colide')
  const external = fs.mkdtempSync(path.join(os.tmpdir(), 'supremo-sql-outside-'))
  try {
    fs.symlinkSync(external, path.join(cwd, 'supabase/types'))
    expect(() => materializeSqlFile(cwd, file.replace('migrations', 'types').replace('.sql', '.types.ts'), content, artifactDigest(content))).toThrow('não regular')
    expect(fs.readdirSync(external)).toEqual([])
  } finally { fs.rmSync(external, { recursive: true, force: true }) }
})
it('writes the migration before acknowledgement, types after applied proof and checkpoints without changing preview/HEAD/index', async () => {
  let artifact = sample()
  const types = { path: file.replace('migrations', 'types').replace('.sql', '.types.ts'), content: 'export type Database = {}', digest: artifactDigest('export type Database = {}') }
  const operations: string[] = [], head = gitText(cwd, ['rev-parse', 'HEAD']), index = gitText(cwd, ['write-tree'])
  const client: SqlArtifactClient = { request: vi.fn(async operation => {
    operations.push(operation)
    if (operation === 'materialized') { expect(fs.readFileSync(path.join(cwd, file), 'utf8')).toBe(content); artifact = { ...artifact, state: 'materialized' } }
    if (operation === 'advance') { expect(fs.existsSync(path.join(cwd, types.path))).toBe(false); artifact = { ...artifact, state: 'applied', types } }
    if (operation === 'completed') { expect(fs.readFileSync(path.join(cwd, types.path), 'utf8')).toBe(types.content); artifact = { ...artifact, state: 'succeeded' } }
    return artifact
  }) }
  await sqlArtifactTick(cwd, crypto.randomUUID(), client)
  expect(operations).toEqual(['poll', 'materialized', 'advance', 'completed'])
  expect(gitText(cwd, ['rev-parse', 'HEAD'])).toBe(head); expect(gitText(cwd, ['write-tree'])).toBe(index)
  expect(fs.readFileSync(path.join(cwd, 'app.txt'), 'utf8')).toBe('preview source\n')
  expect(defaultCheckpointDeps(cwd).readQueue().at(-1)?.changedPaths).toEqual([file, types.path])
})
it('does not claim availability or alter files while the editing host owns the workspace', async () => {
  writeJson(path.join(cwd, '.supremo/turns/state.json'), { turn: { status: 'active' } })
  const request = vi.fn<SqlArtifactClient['request']>(async () => null)
  await sqlArtifactTick(cwd, crypto.randomUUID(), { request })
  expect(request).toHaveBeenCalledWith('poll', expect.objectContaining({ ready: false }))
  expect(fs.existsSync(path.join(cwd, file))).toBe(false)
})
it('reports a local conflict and never dispatches application when personal content exists', async () => {
  materializeSqlFile(cwd, file, 'personal', artifactDigest('personal'))
  const request = vi.fn<SqlArtifactClient['request']>(async () => sample())
  await sqlArtifactTick(cwd, crypto.randomUUID(), { request })
  expect(request.mock.calls.map(call => call[0])).toEqual(['poll', 'conflict'])
  expect(fs.readFileSync(path.join(cwd, file), 'utf8')).toBe('personal')
})
