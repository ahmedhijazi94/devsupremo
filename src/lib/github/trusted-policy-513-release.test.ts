import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { gunzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { blobHash } from '../../../packages/cli/src/validation-integrity'
import { verifyTrustedFiles } from '../../../packages/cli/src/trusted-validation'
import { verifyCandidatePolicy } from './trusted-policy'

interface ArchivedFile { path: string; content: string; mode?: string }
interface ArchivedProject { version: string; kind: 'public' | 'solo' | 'team'; files: ArchivedFile[] }
interface ReleasedFixture { sourceCommit: string; projects: ArchivedProject[] }
const fixtureBytes = readFileSync(new URL('./fixtures/validation-files-4.0.15-5.1.3.json.gz', import.meta.url))
const fixture = JSON.parse(gunzipSync(fixtureBytes).toString('utf8')) as ReleasedFixture
const workspaces: string[] = []
const sha = 'a'.repeat(40)

function materialize(project: ArchivedProject): string {
  const cwd = mkdtempSync(join(tmpdir(), 'supremo-release-513-'))
  workspaces.push(cwd)
  for (const file of project.files) {
    const target = join(cwd, file.path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, file.content, { mode: file.mode === '100755' ? 0o755 : 0o644 })
  }
  return cwd
}

function candidate(project: ArchivedProject, files = project.files) {
  return { headSha: sha, kind: project.kind, truncated: false,
    tree: files.map(file => ({ path: file.path, sha: blobHash(file.content), mode: file.mode ?? '100644' })),
    packageContent: files.find(file => file.path === 'package.json')!.content,
    lockContent: files.find(file => file.path === 'package-lock.json')!.content,
  }
}

afterEach(() => { for (const cwd of workspaces.splice(0)) rmSync(cwd, { recursive: true, force: true }) })

describe('release 5.1.3 remains authorized after engine upgrades', () => {
  it('pins the actual release files rather than regenerating them from the current scaffold', () => {
    expect(fixture.sourceCommit).toBe('ad6469919f66cdd94fb4d9664cc93d38f769e889')
    expect(createHash('sha256').update(fixtureBytes).digest('hex')).toBe('50d8db7d7f1a28dd41628e598aa4dc10b7788fd5548f1a588a88bfcb2bd3bc36')
    expect(fixture.projects.map(project => `${project.version}/${project.kind}`)).toEqual([
      '4.0.15/public', '4.0.15/solo', '4.0.15/team', '5.1.3/public', '5.1.3/solo', '5.1.3/team',
    ])
  })
  it.each(fixture.projects)('accepts $version/$kind on the server and local worker without rewriting it', project => {
    const cwd = materialize(project)
    expect(verifyCandidatePolicy(candidate(project))).toMatchObject({ approved: true, reasons: [] })
    expect(() => verifyTrustedFiles(cwd)).not.toThrow()
    for (const file of project.files) expect(readFileSync(join(cwd, file.path), 'utf8')).toBe(file.content)
    const lock = JSON.parse(readFileSync(join(cwd, 'package-lock.json'), 'utf8')) as { packages: Record<string, { version?: string }> }
    expect(lock.packages['tools/supremo-cli']?.version).toBe('1.12.0')
  })
  it.each(fixture.projects)('rejects modified validation authority in archived $version/$kind', project => {
    const cwd = materialize(project)
    const tampered = project.files.map(file => file.path === 'scripts/verify.mjs' ? { ...file, content: 'process.exit(0)' } : file)
    expect(verifyCandidatePolicy(candidate(project, tampered)).approved).toBe(false)
    writeFileSync(join(cwd, 'scripts/verify.mjs'), 'process.exit(0)')
    expect(() => verifyTrustedFiles(cwd)).toThrow(/base de validação/)
    writeFileSync(join(cwd, 'scripts/verify.mjs'), project.files.find(file => file.path === 'scripts/verify.mjs')!.content)

    const lockFile = project.files.find(file => file.path === 'package-lock.json')!
    const lock = JSON.parse(lockFile.content) as { packages: Record<string, { version?: string }> }
    lock.packages['tools/supremo-cli']!.version = '999.0.0'
    const changedLock = JSON.stringify(lock)
    expect(verifyCandidatePolicy(candidate(project, project.files.map(file => file === lockFile ? { ...file, content: changedLock } : file))).approved).toBe(false)
    writeFileSync(join(cwd, 'package-lock.json'), changedLock)
    expect(() => verifyTrustedFiles(cwd)).toThrow(/base de validação/)
    writeFileSync(join(cwd, 'package-lock.json'), lockFile.content)

    const extraWorkflow = { path: '.github/workflows/unapproved.yml', content: 'name: Unapproved' }
    expect(verifyCandidatePolicy(candidate(project, [...project.files, extraWorkflow])).approved).toBe(false)
    writeFileSync(join(cwd, extraWorkflow.path), extraWorkflow.content)
    expect(() => verifyTrustedFiles(cwd)).toThrow(/não autorizada/)
  })
})
