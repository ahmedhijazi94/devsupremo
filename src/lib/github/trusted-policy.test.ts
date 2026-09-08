import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { buildProjectFiles } from '../templates/project-files'
import { blobHash, lockEntryHash } from '../../../packages/cli/src/validation-integrity'
import { selectTrustedWorkflow, verifyCandidatePolicy, verifyPolicyChanges, workflowChecks, type WorkflowEvidence } from './trusted-policy'
import { TRUSTED_VALIDATION_POLICIES_4_0_2 } from './validation-policy-releases/4.0.2'

const SHA = 'a'.repeat(40)
type Kind = 'public' | 'solo' | 'team'
type Candidate = Parameters<typeof verifyCandidatePolicy>[0]
interface ReleasedFixture {
  schemaVersion: number
  templateVersion: string
  sourceCommit: string
  common: Pick<Candidate, 'packageContent' | 'lockContent'>
  kinds: Record<Kind, Pick<Candidate, 'tree'>>
}
const releasedFixture = JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/validation-policy-4.0.2.json.gz', import.meta.url))).toString('utf8')) as ReleasedFixture
function previousCandidate(kind: Kind = 'solo'): Candidate {
  return { ...releasedFixture.common, headSha: SHA, kind, truncated: false,
    tree: releasedFixture.kinds[kind].tree.map(entry => ({ ...entry })) }
}
function replaceMetadata(input: Candidate, path: 'package.json' | 'package-lock.json', content: string): Candidate {
  return { ...input, ...(path === 'package.json' ? { packageContent: content } : { lockContent: content }),
    tree: input.tree.map(entry => entry.path === path ? { ...entry, sha: blobHash(content) } : entry) }
}
function candidate(kind: 'public' | 'solo' | 'team' = 'solo', changes: Record<string, string | null> = {}) {
  const files = new Map(buildProjectFiles({ projectName: 'real-app', description: 'Own app', kind }).map(f => [f.path, f.content]))
  for (const [path, content] of Object.entries(changes)) if (content === null) files.delete(path); else files.set(path, content)
  return { headSha: SHA, kind, truncated: false, tree: [...files].map(([path, content]) => ({ path, sha: blobHash(content), mode: '100644' })), packageContent: files.get('package.json')!, lockContent: files.get('package-lock.json')! }
}
function packageEdit(edit: (pkg: Record<string, unknown>) => void) {
  const pkg = JSON.parse(candidate().packageContent) as Record<string, unknown>
  edit(pkg)
  return candidate('solo', { 'package.json': JSON.stringify(pkg) })
}

describe('independent engine policy over actual generated candidates', () => {
  it('pins the complete historical authority to its recorded immutable release contents', () => {
    expect(createHash('sha256').update(JSON.stringify(TRUSTED_VALIDATION_POLICIES_4_0_2)).digest('hex'))
      .toBe('ac8079a1684751bcac5bbba1bdd6d4dea09d6f19a27691f58f6cd518090b11aa')
  })
  it('refuses altered CI rails before publish and allows exact engine base upgrades', () => {
    const ci = buildProjectFiles({ projectName: 'app', description: '' }).find(file => file.path === '.github/workflows/ci.yml')!
    expect(verifyPolicyChanges('solo', [{ path: ci.path, op: 'modify', contentBase64: Buffer.from(ci.content).toString('base64') }])).toEqual([])
    for (const file of [
      { path: ci.path, op: 'delete' as const },
      { path: ci.path, op: 'modify' as const, contentBase64: Buffer.from('name: fake').toString('base64') },
      { path: '.github/workflows/fake.yml', op: 'add' as const, contentBase64: '' },
    ]) expect(verifyPolicyChanges('solo', [file])).not.toEqual([])
    expect(verifyPolicyChanges(null, [{ path: 'app/page.tsx', op: 'modify', contentBase64: '' }])).toEqual([])
    expect(verifyPolicyChanges('unknown', [])).not.toEqual([])
  })
  it.each(['public', 'solo', 'team'] as const)('accepts intact released %s validators', kind => {
    expect(verifyCandidatePolicy(candidate(kind))).toMatchObject({ approved: true, reasons: [] })
  })
  it.each(['public', 'solo', 'team'] as const)('keeps the actual archived 4.0.2 %s scaffold authorized after release 4.0.3', kind => {
    expect(releasedFixture).toMatchObject({ schemaVersion: 1, templateVersion: '4.0.2',
      sourceCommit: 'ae3285a13b91d7b3931d8a80a7f0647dc4cb1c92' })
    const previous = previousCandidate(kind)
    const current = candidate(kind)
    const cliVersion = (input: Candidate): string => (JSON.parse(input.lockContent) as { packages: Record<string, { version?: string }> }).packages['tools/supremo-cli']!.version!
    expect(cliVersion(previous)).toBe('1.7.2')
    expect(cliVersion(current)).toBe('1.7.3')
    expect(verifyCandidatePolicy(previous)).toMatchObject({ approved: true, headSha: SHA, reasons: [] })
    expect(verifyCandidatePolicy(current)).toMatchObject({ approved: true, headSha: SHA, reasons: [] })
  })
  it.each([previousCandidate, candidate])('preserves full integrity for each release: versions, paths, dependencies, validators and immutable metadata', build => {
    const input = build('solo')
    for (const edit of [
      (packages: Record<string, Record<string, unknown>>) => { packages['tools/supremo-cli']!.version = '1.7.4' },
      (packages: Record<string, Record<string, unknown>>) => { packages['tools/supremo-cli']!.bin = { supremo: './untrusted.js' } },
      (packages: Record<string, Record<string, unknown>>) => { packages['node_modules/vitest']!.resolved = 'https://attacker.invalid/test.tgz' },
      (packages: Record<string, Record<string, unknown>>) => { packages['tools/other-cli'] = packages['tools/supremo-cli']!; delete packages['tools/supremo-cli'] },
    ]) {
      const lock = JSON.parse(input.lockContent) as { packages: Record<string, Record<string, unknown>> }
      edit(lock.packages)
      expect(verifyCandidatePolicy(replaceMetadata(input, 'package-lock.json', JSON.stringify(lock))).approved).toBe(false)
    }
    const altered = { ...input, tree: input.tree.map(entry => entry.path === 'scripts/verify.mjs' ? { ...entry, sha: blobHash('process.exit(0)') } : entry) }
    expect(verifyCandidatePolicy(altered).approved).toBe(false)
    expect(verifyCandidatePolicy({ ...input, lockContent: input.lockContent + ' ' }).approved).toBe(false)
    const pkg = JSON.parse(input.packageContent) as { devDependencies: Record<string, string> }
    pkg.devDependencies['supremo-cli'] = 'file:tools/other-cli'
    expect(verifyCandidatePolicy(replaceMetadata(input, 'package.json', JSON.stringify(pkg))).approved).toBe(false)
  })
  it('does not let candidate-declared policy metadata authorize an unapproved tool version', () => {
    const input = previousCandidate()
    const lock = JSON.parse(input.lockContent) as { packages: Record<string, Record<string, unknown>> }
    lock.packages['tools/supremo-cli']!.version = '999.0.0'
    const altered = replaceMetadata(input, 'package-lock.json', JSON.stringify(lock))
    const claimed = { ...altered, tree: [...altered.tree,
      { path: '.supremo/validation-policy.json', sha: blobHash(JSON.stringify({ version: '4.0.2', approved: true })), mode: '100644' }] }
    expect(verifyCandidatePolicy(claimed).approved).toBe(false)
  })
  it.each(['scripts/verify.mjs', 'scripts/security-audit.js', '.github/workflows/ci.yml', 'vitest.config.ts', 'supabase/isolation.ts'])('rejects validator tampering: %s', path => {
    expect(verifyCandidatePolicy(candidate('solo', { [path]: 'process.exit(0)' })).approved).toBe(false)
    expect(verifyCandidatePolicy(candidate('solo', { [path]: null })).approved).toBe(false)
  })
  it('rejects a second workflow which spoofs the same check names', () => {
    expect(verifyCandidatePolicy(candidate('solo', { '.github/workflows/fake.yml': 'name: Gates' })).approved).toBe(false)
  })
  it('rejects shortened commands, lifecycle hooks, tool overrides and altered tools', () => {
    for (const edit of [
      (pkg: Record<string, unknown>) => { (pkg.scripts as Record<string, string>).test = 'echo passed' },
      (pkg: Record<string, unknown>) => { (pkg.scripts as Record<string, string>).pretest = 'node weaken-tests.js' },
      (pkg: Record<string, unknown>) => { (pkg.scripts as Record<string, string>).postinstall = 'node weaken-tools.js' },
      (pkg: Record<string, unknown>) => { pkg.overrides = { vitest: 'npm:fake-test@1.0.0' } },
      (pkg: Record<string, unknown>) => { (pkg.devDependencies as Record<string, string>).vitest = 'file:./fake-test' },
    ]) expect(verifyCandidatePolicy(packageEdit(edit)).approved).toBe(false)
  })
  it('rejects redirected locked artifacts even if package scripts and versions are intact', () => {
    const lock = JSON.parse(candidate().lockContent) as { packages: Record<string, Record<string, unknown>> }
    lock.packages['node_modules/vitest']!.resolved = 'https://attacker.invalid/test.tgz'
    expect(verifyCandidatePolicy(candidate('solo', { 'package-lock.json': JSON.stringify(lock) })).approved).toBe(false)
  })
  it('permits ordinary app changes and additional application dependencies', () => {
    const input = packageEdit(pkg => { (pkg.dependencies as Record<string, string>)['application-library'] = '1.0.0' })
    input.tree.push({ path: 'app/tickets/actions.ts', sha: blobHash('application code'), mode: '100644' })
    expect(verifyCandidatePolicy(input).approved).toBe(true)
  })
  it('binds authority to project kind, content SHA, complete tree, and regular file mode', () => {
    const base = candidate()
    for (const input of [{ ...base, kind: 'unknown' }, { ...base, headSha: 'branch' }, { ...base, truncated: true }, { ...base, packageContent: '{}' }, { ...base, lockContent: '[' }]) expect(verifyCandidatePolicy(input).approved).toBe(false)
    const symlink = candidate()
    symlink.tree.find(entry => entry.path === 'scripts/verify.mjs')!.mode = '120000'
    expect(verifyCandidatePolicy(symlink).approved).toBe(false)
    expect(verifyCandidatePolicy({ ...candidate('public'), kind: 'solo' }).approved).toBe(false)
  })
  it('compares canonical lock identity without trusting dev/optional classification', () => {
    expect(lockEntryHash({ version: '1', dev: true, dependencies: { a: '1', b: '2' } })).toBe(lockEntryHash({ dependencies: { b: '2', a: '1' }, version: '1', optional: true }))
    expect(lockEntryHash(null)).not.toBe(lockEntryHash({ version: '1' }))
  })
})

const workflow: WorkflowEvidence = { id: 1, head_sha: SHA, path: '.github/workflows/ci.yml', event: 'pull_request', run_number: 1, run_attempt: 1, status: 'completed', conclusion: 'success' }
describe('workflow provenance and reruns', () => {
  it('ignores workflows from another path, another revision, or pull_request_target', () => {
    expect(selectTrustedWorkflow([{ ...workflow, path: '.github/workflows/fake.yml' }, { ...workflow, head_sha: 'b'.repeat(40) }, { ...workflow, event: 'pull_request_target' }], SHA)).toBeUndefined()
  })
  it('selects the newest trusted rerun even if the older one was green', () => {
    const pending = { ...workflow, run_attempt: 2, status: 'in_progress', conclusion: null }
    expect(selectTrustedWorkflow([workflow, pending], SHA)).toEqual(pending)
  })
  it('rejects ambiguous duplicated job names', () => {
    const job = { name: 'Tests', status: 'completed', conclusion: 'success' }
    expect(workflowChecks(undefined, [job])).toEqual([])
    expect(workflowChecks(workflow, [job])).toEqual([job])
    expect(workflowChecks(workflow, [job, job]).every(item => item.conclusion === 'failure')).toBe(true)
  })
})
