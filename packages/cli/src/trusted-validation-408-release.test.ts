import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { verifyTrustedFiles } from './trusted-validation'

type Kind = 'public' | 'solo' | 'team'
interface ArchivedFile { path: string; content: string; mode?: string }
interface ArchivedFiles {
  templateVersion: string
  sourceCommit: string
  kinds: Record<Kind, { files: ArchivedFile[] }>
}
interface ArchivedMetadata { common: { packageContent: string; lockContent: string } }

const fixtureBytes = readFileSync(new URL('../../../src/lib/github/fixtures/validation-files-4.0.8.json.gz', import.meta.url))
const files = JSON.parse(gunzipSync(fixtureBytes).toString('utf8')) as ArchivedFiles
const metadata = JSON.parse(gunzipSync(readFileSync(new URL('../../../src/lib/github/fixtures/validation-policy-4.0.8.json.gz', import.meta.url))).toString('utf8')) as ArchivedMetadata
const workspaces: string[] = []

function materialize(kind: Kind): string {
  const cwd = mkdtempSync(join(tmpdir(), 'supremo-trusted-release-'))
  workspaces.push(cwd)
  for (const file of files.kinds[kind].files) {
    const target = join(cwd, file.path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, file.content, { mode: file.mode === '100755' ? 0o755 : 0o644 })
  }
  writeFileSync(join(cwd, 'package.json'), metadata.common.packageContent)
  writeFileSync(join(cwd, 'package-lock.json'), metadata.common.lockContent)
  return cwd
}

function snapshot(cwd: string, kind: Kind): Record<string, string> {
  return Object.fromEntries([...files.kinds[kind].files.map(file => file.path), 'package.json', 'package-lock.json']
    .map(file => [file, readFileSync(join(cwd, file), 'utf8')]))
}

afterEach(() => { for (const cwd of workspaces.splice(0)) rmSync(cwd, { recursive: true, force: true }) })

describe('current engine verifies immutable 4.0.8 project rails', () => {
  it('pins the archived validator bytes to the published source commit', () => {
    expect(files).toMatchObject({ templateVersion: '4.0.8', sourceCommit: '3071f69596ab18e8c5a224c734af1227b22ec069' })
    expect(createHash('sha256').update(fixtureBytes).digest('hex'))
      .toBe('d90bae22025418d283135e6b3bf072a0a3d31bbdf2b7f6bbc5727208e564ead8')
  })
  it.each(['public', 'solo', 'team'] as const)('accepts the archived %s project without rewriting its rails or lockfile', kind => {
    const cwd = materialize(kind)
    const before = snapshot(cwd, kind)
    expect(() => verifyTrustedFiles(cwd)).not.toThrow()
    expect(snapshot(cwd, kind)).toEqual(before)
    const lock = JSON.parse(readFileSync(join(cwd, 'package-lock.json'), 'utf8')) as { packages: Record<string, { version?: string }> }
    expect(lock.packages['tools/supremo-cli']?.version).toBe('1.7.7')
  })
  it.each(['public', 'solo', 'team'] as const)('rejects altered validators, tool identity and extra workflows in the archived %s project', kind => {
    const cwd = materialize(kind)
    const validator = join(cwd, 'scripts/verify.mjs')
    const original = readFileSync(validator, 'utf8')
    writeFileSync(validator, 'process.exit(0)')
    expect(() => verifyTrustedFiles(cwd)).toThrow('Validador ausente ou alterado')
    writeFileSync(validator, original)

    const lock = JSON.parse(metadata.common.lockContent) as { packages: Record<string, { version?: string }> }
    lock.packages['tools/supremo-cli']!.version = '999.0.0'
    writeFileSync(join(cwd, 'package-lock.json'), JSON.stringify(lock))
    expect(() => verifyTrustedFiles(cwd)).toThrow('base de validação precisa ser atualizada')
    writeFileSync(join(cwd, 'package-lock.json'), metadata.common.lockContent)

    writeFileSync(join(cwd, '.github/workflows/fake.yml'), 'name: Gates')
    expect(() => verifyTrustedFiles(cwd)).toThrow('não autorizada')
  })
})
