import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { buildProjectFiles } from '../templates/project-files'
import { blobHash, lockEntryHash } from '../../../packages/cli/src/validation-integrity'
import { selectTrustedWorkflow, verifyCandidatePolicy, verifyPolicyChanges, workflowChecks, type WorkflowEvidence } from './trusted-policy'
import { TRUSTED_VALIDATION_POLICIES_4_0_2 } from './validation-policy-releases/4.0.2'
import { TRUSTED_VALIDATION_POLICIES_4_0_4 } from './validation-policy-releases/4.0.4'
import { TRUSTED_VALIDATION_POLICIES_4_0_5 } from './validation-policy-releases/4.0.5'
import { TRUSTED_VALIDATION_POLICIES_4_0_6 } from './validation-policy-releases/4.0.6'
import { TRUSTED_VALIDATION_POLICIES_4_0_7 } from './validation-policy-releases/4.0.7'
import { TRUSTED_VALIDATION_POLICIES_4_0_8 } from './validation-policy-releases/4.0.8'
import { TRUSTED_VALIDATION_POLICIES_4_0_9 } from './validation-policy-releases/4.0.9'
import { TRUSTED_VALIDATION_POLICIES_4_0_10_5_0_0 } from './validation-policy-releases/4.0.10-5.0.0'
import { TRUSTED_VALIDATION_POLICIES_4_0_11_5_0_1 } from './validation-policy-releases/4.0.11-5.0.1'
import { TRUSTED_VALIDATION_POLICIES_4_0_12_5_1_0 } from './validation-policy-releases/4.0.12-5.1.0'

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
const releasedFixture404 = JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/validation-policy-4.0.4.json.gz', import.meta.url))).toString('utf8')) as ReleasedFixture
const releasedFixture405 = JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/validation-policy-4.0.5.json.gz', import.meta.url))).toString('utf8')) as ReleasedFixture
function previousCandidate(kind: Kind = 'solo'): Candidate {
  return { ...releasedFixture.common, headSha: SHA, kind, truncated: false,
    tree: releasedFixture.kinds[kind].tree.map(entry => ({ ...entry })) }
}
function previous404Candidate(kind: Kind = 'solo'): Candidate {
  return { ...releasedFixture404.common, headSha: SHA, kind, truncated: false,
    tree: releasedFixture404.kinds[kind].tree.map(entry => ({ ...entry })) }
}
function previous405Candidate(kind: Kind = 'solo'): Candidate {
  return { ...releasedFixture405.common, headSha: SHA, kind, truncated: false,
    tree: releasedFixture405.kinds[kind].tree.map(entry => ({ ...entry })) }
}
function replaceMetadata(input: Candidate, path: 'package.json' | 'package-lock.json', content: string): Candidate {
  return { ...input, ...(path === 'package.json' ? { packageContent: content } : { lockContent: content }),
    tree: input.tree.map(entry => entry.path === path ? { ...entry, sha: blobHash(content) } : entry) }
}
function candidate(kind: 'public' | 'solo' | 'team' = 'solo', changes: Record<string, string | null> = {}, stack: 'nextjs' | 'tanstack-start-vite' = 'nextjs') {
  const files = new Map(buildProjectFiles({ projectName: 'real-app', description: 'Own app', kind, stack }).map(f => [f.path, f.content]))
  for (const [path, content] of Object.entries(changes)) if (content === null) files.delete(path); else files.set(path, content)
  return { headSha: SHA, kind, truncated: false, tree: [...files].map(([path, content]) => ({ path, sha: blobHash(content), mode: '100644' })), packageContent: files.get('package.json')!, lockContent: files.get('package-lock.json')! }
}
function packageEdit(edit: (pkg: Record<string, unknown>) => void) {
  const pkg = JSON.parse(candidate().packageContent) as Record<string, unknown>
  edit(pkg)
  return candidate('solo', { 'package.json': JSON.stringify(pkg) })
}

describe('independent engine policy over actual generated candidates', () => {
  it('4.0.4 preserves the complete validation authority released in 4.0.3', () => {
    // Hash da política em 09e6723, removendo apenas o número da versão.
    // Alterar validadores numa versão futura exige arquivar esta autoridade.
    const authority = TRUSTED_VALIDATION_POLICIES_4_0_4.map(({ version, ...policy }) => {
      expect(version).toBe('4.0.4')
      return policy
    })
    expect(createHash('sha256').update(JSON.stringify(authority)).digest('hex'))
      .toBe('73a1698a206c284dd66eaf835edf855e574a16abba9eea9774de8a1e73cba161')
  })
  it('pins the complete historical authority to its recorded immutable release contents', () => {
    expect(createHash('sha256').update(JSON.stringify(TRUSTED_VALIDATION_POLICIES_4_0_12_5_1_0)).digest('hex')).toBe('2d64da87947fcbda6437bee9125ce346ea979a972ad5ad3d2643f02a596e2102')
    expect(createHash('sha256').update(JSON.stringify(TRUSTED_VALIDATION_POLICIES_4_0_11_5_0_1)).digest('hex')).toBe('d4690c96401912958c7f6b0894f458f18ef450fce62cdae8c191a885eb47ba8d')
    expect(createHash('sha256').update(JSON.stringify(TRUSTED_VALIDATION_POLICIES_4_0_10_5_0_0)).digest('hex')).toBe('6d4101e5b7582fbd1d5dbcd88d8b42bc1edb36fad410ef1af0b454d9ca758200')
    expect(createHash('sha256').update(JSON.stringify(TRUSTED_VALIDATION_POLICIES_4_0_9)).digest('hex')).toBe('d45b2a79ab9869075760051d61ec73aa408ea7fe13e6b4f017ec13eb69a644cb')
    expect(createHash('sha256').update(JSON.stringify(TRUSTED_VALIDATION_POLICIES_4_0_8)).digest('hex')).toBe('fcff94f43c1d3b112ca1fd7ab7d8c6b80697c95fc8ace583e575813f82e4e223')
    expect(createHash('sha256').update(JSON.stringify(TRUSTED_VALIDATION_POLICIES_4_0_7)).digest('hex')).toBe('3b4a199e3b414ee51691026d0b1db3db96e3f6b17a240ad69e06ed752494d4cf')
    expect(createHash('sha256').update(JSON.stringify(TRUSTED_VALIDATION_POLICIES_4_0_6)).digest('hex'))
      .toBe('4342233dc49919270c2c33093b0f7afcda7a952333e240136b4c5c72b0591ae8')
    expect(createHash('sha256').update(JSON.stringify(TRUSTED_VALIDATION_POLICIES_4_0_2)).digest('hex'))
      .toBe('ac8079a1684751bcac5bbba1bdd6d4dea09d6f19a27691f58f6cd518090b11aa')
    expect(createHash('sha256').update(JSON.stringify(TRUSTED_VALIDATION_POLICIES_4_0_4)).digest('hex'))
      .toBe('861344ab9f225ebe667002a61194f65ae7df144cefdf2210d1c4321925e23904')
    expect(createHash('sha256').update(JSON.stringify(TRUSTED_VALIDATION_POLICIES_4_0_5)).digest('hex'))
      .toBe('43c6b61a351ca0c4b6f0f76e9bbeb660a5165f52863da722f37b68007c564be5')
  })
  it.each(['4.0.10', '5.0.0'])('preserves all three profiles from release %s after onboarding upgrade', version => {
    const fixture = JSON.parse(gunzipSync(readFileSync(new URL(`./fixtures/validation-policy-${version}.json.gz`, import.meta.url))).toString('utf8')) as ReleasedFixture
    expect(fixture.sourceCommit).toBe('8f027a328c2797da5f317a2b093f91362f929451')
    for (const kind of ['public', 'solo', 'team'] as const) {
      const input = { ...fixture.common, headSha: SHA, kind, truncated: false, tree: fixture.kinds[kind].tree }
      expect(verifyCandidatePolicy(input)).toMatchObject({ approved: true, reasons: [] })
      expect(verifyCandidatePolicy({ ...input, tree: input.tree.map(entry => entry.path === 'scripts/verify.mjs' ? { ...entry, sha: '0'.repeat(40) } : entry) }).approved).toBe(false)
    }
  })
  it.each(['4.0.10', '5.0.0'])('preserves the CLI 1.8.1 release over the unchanged %s validation rails', version => {
    // Releases 4.0.11/5.0.1 kept these validators and dependencies, upgrading only
    // the bundled CLI lock entry. Reuse the independent released project fixture.
    const fixture = JSON.parse(gunzipSync(readFileSync(new URL(`./fixtures/validation-policy-${version}.json.gz`, import.meta.url))).toString('utf8')) as ReleasedFixture
    const lock = JSON.parse(fixture.common.lockContent) as { packages: Record<string, { version?: string }> }
    lock.packages['tools/supremo-cli']!.version = '1.8.1'
    for (const kind of ['public', 'solo', 'team'] as const) {
      const input = replaceMetadata({ ...fixture.common, headSha: SHA, kind, truncated: false, tree: fixture.kinds[kind].tree }, 'package-lock.json', JSON.stringify(lock))
      expect(verifyCandidatePolicy(input)).toMatchObject({ approved: true, reasons: [] })
      expect(verifyCandidatePolicy({ ...input, tree: input.tree.map(entry => entry.path === 'scripts/verify.mjs' ? { ...entry, sha: '0'.repeat(40) } : entry) }).approved).toBe(false)
      lock.packages['tools/supremo-cli']!.version = '999.0.0'
      expect(verifyCandidatePolicy(replaceMetadata(input, 'package-lock.json', JSON.stringify(lock))).approved).toBe(false)
      lock.packages['tools/supremo-cli']!.version = '1.8.1'
    }
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
  it.each(['public', 'solo', 'team'] as const)('preserves the actual 4.0.7 %s project and refuses a modified old validator', kind => {
    const fixture = JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/validation-policy-4.0.7.json.gz', import.meta.url))).toString('utf8')) as ReleasedFixture
    expect(fixture.sourceCommit).toBe('ec851c7fa6461a1ccafae210b06f580c1b902071')
    const input = { ...fixture.common, headSha: SHA, kind, truncated: false, tree: fixture.kinds[kind].tree }
    expect(verifyCandidatePolicy(input)).toMatchObject({ approved: true, reasons: [] })
    expect(verifyCandidatePolicy({ ...input, tree: input.tree.map(entry => entry.path === 'e2e/smoke.spec.ts' ? { ...entry, sha: '0'.repeat(40) } : entry) }).approved).toBe(false)
  })
  it.each(['public', 'solo', 'team'] as const)('preserves the actual 4.0.8 %s project when upgrading the upload worker', kind => {
    const fixture = JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/validation-policy-4.0.8.json.gz', import.meta.url))).toString('utf8')) as ReleasedFixture
    expect(fixture.sourceCommit).toBe('3071f69596ab18e8c5a224c734af1227b22ec069')
    const input = { ...fixture.common, headSha: SHA, kind, truncated: false, tree: fixture.kinds[kind].tree }
    expect(verifyCandidatePolicy(input)).toMatchObject({ approved: true, reasons: [] })
    expect(verifyCandidatePolicy({ ...input, tree: input.tree.map(entry => entry.path === 'e2e/smoke.spec.ts' ? { ...entry, sha: '0'.repeat(40) } : entry) }).approved).toBe(false)
    const lock = JSON.parse(input.lockContent) as { packages: Record<string, { version?: string }> }
    lock.packages['tools/supremo-cli']!.version = '999.0.0'
    expect(verifyCandidatePolicy(replaceMetadata(input, 'package-lock.json', JSON.stringify(lock))).approved).toBe(false)
  })
  it.each(['public', 'solo', 'team'] as const)('authorizes the complete Start %s release without permitting weaker rails', kind => {
    const input = candidate(kind, {}, 'tanstack-start-vite')
    expect(verifyCandidatePolicy(input)).toMatchObject({ approved: true, headSha: SHA, reasons: [] })
    for (const path of ['vite.config.mts', 'vitest.config.mts', 'scripts/generate-routes.mjs', 'scripts/start-production.mjs', 'scripts/browser-diagnostics.ts', 'scripts/security-audit.js', '.github/workflows/ci.yml']) {
      expect(verifyCandidatePolicy(candidate(kind, { [path]: 'process.exit(0)' }, 'tanstack-start-vite')).approved).toBe(false)
      expect(verifyCandidatePolicy(candidate(kind, { [path]: null }, 'tanstack-start-vite')).approved).toBe(false)
    }
    const pkg = JSON.parse(input.packageContent) as { scripts: Record<string, string> }
    pkg.scripts['routes:generate'] = 'echo bypass'
    expect(verifyCandidatePolicy(replaceMetadata(input, 'package.json', JSON.stringify(pkg))).approved).toBe(false)
    const next = candidate(kind)
    const mixed = { ...input, tree: input.tree.map(entry => entry.path === 'scripts/security-audit.js' ? next.tree.find(file => file.path === entry.path)! : entry) }
    expect(verifyCandidatePolicy(mixed).approved).toBe(false)
  })
  it.each(['public', 'solo', 'team'] as const)('accepts intact released %s validators', kind => {
    expect(verifyCandidatePolicy(candidate(kind))).toMatchObject({ approved: true, reasons: [] })
  })
  it.each(['public', 'solo', 'team'] as const)('keeps the actual archived 4.0.2 %s scaffold authorized after release 4.0.6', kind => {
    expect(releasedFixture).toMatchObject({ schemaVersion: 1, templateVersion: '4.0.2',
      sourceCommit: 'ae3285a13b91d7b3931d8a80a7f0647dc4cb1c92' })
    const previous = previousCandidate(kind)
    const current = candidate(kind)
    const cliVersion = (input: Candidate): string => (JSON.parse(input.lockContent) as { packages: Record<string, { version?: string }> }).packages['tools/supremo-cli']!.version!
    expect(cliVersion(previous)).toBe('1.7.2')
    expect(cliVersion(current)).toBe('1.12.1')
    expect(verifyCandidatePolicy(previous)).toMatchObject({ approved: true, headSha: SHA, reasons: [] })
    expect(verifyCandidatePolicy(current)).toMatchObject({ approved: true, headSha: SHA, reasons: [] })
  })
  it.each(['public', 'solo', 'team'] as const)('keeps the actual archived 4.0.4 %s scaffold authorized after release 4.0.6', kind => {
    expect(releasedFixture404).toMatchObject({ schemaVersion: 1, templateVersion: '4.0.4',
      sourceCommit: 'baf34b78cef2975ad89b43137fa01fa934d148ee' })
    const previous = previous404Candidate(kind)
    const lock = JSON.parse(previous.lockContent) as { packages: Record<string, { version?: string }> }
    expect(lock.packages['tools/supremo-cli']?.version).toBe('1.7.3')
    expect(verifyCandidatePolicy(previous)).toMatchObject({ approved: true, headSha: SHA, reasons: [] })
  })
  it.each(['public', 'solo', 'team'] as const)('keeps the actual archived 4.0.5 %s scaffold authorized after release 4.0.6', kind => {
    expect(releasedFixture405).toMatchObject({ schemaVersion: 1, templateVersion: '4.0.5',
      sourceCommit: 'f4acc40aa55bee2371cfc4b9a3e8aa8c9c8504cc' })
    const previous = previous405Candidate(kind)
    const lock = JSON.parse(previous.lockContent) as { packages: Record<string, { version?: string }> }
    expect(lock.packages['tools/supremo-cli']?.version).toBe('1.7.4')
    expect(verifyCandidatePolicy(previous)).toMatchObject({ approved: true, headSha: SHA, reasons: [] })
  })
  it.each([previousCandidate, previous404Candidate, previous405Candidate, candidate])('preserves full integrity for each release: versions, paths, dependencies, validators and immutable metadata', build => {
    const input = build('solo')
    for (const edit of [
      (packages: Record<string, Record<string, unknown>>) => { packages['tools/supremo-cli']!.version = '999.0.0' },
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
