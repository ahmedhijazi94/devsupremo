/** Runs the real generated verifier in the real isolated worker, without providers. */
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { captureTurnCheckpoint, gitText, writeJson } from '../packages/cli/src/turn-workspace'
import { validateCheckpoint } from '../packages/cli/src/turn-validation'

const root = fs.realpathSync(process.argv[2] ?? '')
if (!/^\/(?:private\/)?tmp\/(?:supremo-[^/]+|generated)$/.test(root)) throw new Error('Use um scaffold descartável em /tmp.')
if (fs.existsSync(path.join(root, '.git'))) throw new Error('O teste exige um scaffold ainda sem histórico Git.')
const metadata = path.join(root, '.supremo/project.json')
const projectId = crypto.randomUUID()
writeJson(metadata, { ...JSON.parse(fs.readFileSync(metadata, 'utf8')) as Record<string, unknown>, projectId })
gitText(root, ['init', '-b', 'main'])
gitText(root, ['config', 'user.name', 'Supremo QA'])
gitText(root, ['config', 'user.email', 'qa@example.invalid'])
gitText(root, ['add', '-A'])
gitText(root, ['commit', '-m', 'Disposable generated fixture'])
const initialHead = gitText(root, ['rev-parse', 'HEAD'])
const initialIndex = fs.readFileSync(path.join(root, '.git/index'))
// A cosmetic source change must exercise the browser, without forcing a full build.
fs.appendFileSync(path.join(root, 'app/page.tsx'), '\n// Disposable browser validation probe\n')
const record = captureTurnCheckpoint(root, { projectId, turnId: 'generated-worker-qa',
  summary: 'Generated worker integration', environment: 'development' })
assert.ok(record)
const evidence = await validateCheckpoint(root, record)
writeJson(path.join(root, '.supremo/generated-worker-evidence.json'), evidence)
assert.equal(evidence.status, 'passed', evidence.logs)
for (const type of ['typecheck', 'lint', 'security', 'unit', 'e2e']) {
  assert.ok(evidence.checks.some(check => check.type === type && check.status === 'passed'), `Missing ${type} proof`)
}
assert.equal(evidence.checks.some(check => check.type === 'build'), false, 'Cosmetic edit should not force a full build')
assert.equal(evidence.sha, record.commitSha)
assert.equal(gitText(root, ['rev-parse', 'HEAD']), initialHead)
assert.deepEqual(fs.readFileSync(path.join(root, '.git/index')), initialIndex)
console.log('✓ Worker real: tipos, lint, cobertura, segurança e browser passaram na SHA isolada; HEAD/staging preservados, sem build obrigatório na edição cosmética.')
