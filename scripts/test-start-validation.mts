/** Real immutable-checkpoint validation of a generated Start app, with deliberate failures.
 * Run on Node 22 LTS: node --import tsx scripts/test-start-validation.mts
 * Creates only an owned temporary repository; does not contact GitHub/Supabase.
 */
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildProjectFiles } from '../src/lib/templates/project-files'
import { captureTurnCheckpoint, gitText, writeJson } from '../packages/cli/src/turn-workspace'
import { validateCheckpoint, type LocalEvidence } from '../packages/cli/src/turn-validation'

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'supremo-start-validation-'))
const root = path.join(workspace, 'app')
const projectId = crypto.randomUUID()
const results: Record<string, unknown> = { workspace, node: process.version, probes: {} }
const minimalEnv = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, CI: '1' }
function write(name: string, content: string) { fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); fs.writeFileSync(path.join(root, name), content) }
function command(args: string[], label: string) {
  try { const output = execFileSync('npm', args, { cwd: root, env: minimalEnv, timeout: 180_000, encoding: 'utf8', maxBuffer: 16_000_000 }); fs.writeFileSync(path.join(workspace, `${label}.log`), output) }
  catch (error) { const failure = error as Error & { stdout?: string; stderr?: string }; fs.writeFileSync(path.join(workspace, `${label}.log`), `${failure.stdout ?? ''}\n${failure.stderr ?? ''}`); throw error }
}
try {
  for (const file of buildProjectFiles({ projectName: 'start-worker-proof', description: 'Isolated validation acceptance', kind: 'solo', stack: 'tanstack-start-vite' })) write(file.path, file.content)
  const metadataPath = path.join(root, '.supremo/project.json')
  writeJson(metadataPath, { ...JSON.parse(fs.readFileSync(metadataPath, 'utf8')) as Record<string, unknown>, projectId })
  // A fixture-only pure module makes a real related-test failure possible without altering rails.
  const helper = 'src/lib/worker-probe.ts'
  const originalHelper = 'export function readProbe(): number { return 1 }\n'
  write(helper, originalHelper)
  write('src/lib/worker-probe.test.ts', "import { expect, it } from 'vitest'\nimport { readProbe } from './worker-probe'\nit('keeps the expected result', () => expect(readProbe()).toBe(1))\n")
  command(['ci', '--no-audit', '--no-fund'], 'npm-ci')
  assert(!fs.existsSync(path.join(root, 'src/routeTree.gen.ts')), 'Fresh installation must not rely on a pre-generated route tree')
  gitText(root, ['init', '-b', 'main'])
  gitText(root, ['config', 'user.name', 'Supremo QA'])
  gitText(root, ['config', 'user.email', 'qa@example.invalid'])
  gitText(root, ['add', '-A'])
  gitText(root, ['commit', '-m', 'Disposable Start validation fixture'])
  const initialHead = gitText(root, ['rev-parse', 'HEAD'])
  const initialIndex = fs.readFileSync(path.join(root, '.git/index'))
  const originalHome = fs.readFileSync(path.join(root, 'src/routes/index.tsx'), 'utf8')
  async function probe(name: string, expectedFailure?: 'typecheck' | 'unit' | 'security') {
    const record = captureTurnCheckpoint(root, { projectId, turnId: `start-validation-${name}`, summary: name, environment: 'development' })
    assert(record, 'Changed tree must produce a checkpoint')
    assert.equal(record.draft, undefined, 'Normal validation cannot rely on draft bypass')
    const beforeTree = gitText(root, ['rev-parse', `${record.commitSha}^{tree}`])
    const evidence = await validateCheckpoint(root, record)
    fs.writeFileSync(path.join(workspace, `${name}.log`), evidence.logs)
    writeJson(path.join(workspace, `${name}.json`), evidence)
    assert.equal(evidence.sha, record.commitSha)
    assert.equal(evidence.fingerprint, beforeTree)
    assert.equal(gitText(root, ['rev-parse', `${record.commitSha}^{tree}`]), beforeTree)
    assert.equal(gitText(root, ['rev-parse', 'HEAD']), initialHead)
    assert.deepEqual(fs.readFileSync(path.join(root, '.git/index')), initialIndex)
    assert(!fs.existsSync(path.join(root, 'src/routeTree.gen.ts')), 'Worker route generation must stay inside its immutable validation checkout')
    if (expectedFailure) {
      assert.equal(evidence.status, 'failed', evidence.logs)
      assert(evidence.checks.some(check => check.type === expectedFailure && check.status === 'failed'), `Expected ${expectedFailure} failure; got ${JSON.stringify(evidence.checks)}\n${evidence.logs}`)
    } else {
      assert.notEqual(evidence.status, 'failed', evidence.logs)
      for (const type of ['typecheck', 'lint', 'security']) assert(evidence.checks.some(check => check.type === type && check.status === 'passed'), `Missing ${type} proof`)
      assert(!evidence.checks.some(check => ['build', 'e2e'].includes(check.type ?? '')), 'Cosmetic edit must retain adaptive validation')
      assert(evidence.checks.some(check => check.type === 'unit'), 'Related-test execution must produce evidence, even when no test is related')
    }
    ;(results.probes as Record<string, unknown>)[name] = { status: evidence.status, checks: evidence.checks, sha: evidence.sha, sourceHeadPreserved: true, stagingPreserved: true, snapshotPreserved: true }
    console.log(`${name}: ${evidence.status} (${evidence.checks.map(check => `${check.type}:${check.status}`).join(', ')})`)
    return evidence satisfies LocalEvidence
  }
  write('src/routes/index.tsx', originalHome + '\n// Cosmetic checkpoint validation acceptance\n')
  await probe('cosmetic')
  write('src/routes/index.tsx', originalHome)
  write(helper, "export function readProbe(): number { return 'deliberate-type-error' }\n")
  await probe('type-error', 'typecheck')
  write(helper, 'export function readProbe(): number { return 2 }\n')
  await probe('test-failure', 'unit')
  write(helper, "export function readProbe(): number { eval('1 + 1'); return 1 }\n")
  await probe('security-finding', 'security')
  write(helper, originalHelper)
  command(['run', 'routes:generate'], 'direct-route-generation')
  assert(fs.readFileSync(path.join(root, 'src/routeTree.gen.ts'), 'utf8').includes('/auth/signout'))
  assert.equal(gitText(root, ['rev-parse', 'HEAD']), initialHead)
  assert.deepEqual(fs.readFileSync(path.join(root, '.git/index')), initialIndex)
  results.directRouteGeneration = 'passed without dev server or production build'
  results.status = 'passed'
  console.log(`✓ Start validation worker acceptance passed: ${path.join(workspace, 'evidence.json')}`)
} catch (error) {
  results.status = 'failed'
  results.error = error instanceof Error ? error.message : String(error)
  throw error
} finally { writeJson(path.join(workspace, 'evidence.json'), results) }
