/** Generated Next app + real browser/Git/processes. Provider context is a controlled fixture. */
import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { chromium } from '@playwright/test'
import { buildSync } from 'esbuild'
import type { BackendTurnContext } from '../src/lib/checkpoint/turn-context'
import { defaultCheckpointDeps } from '../packages/cli/src/checkpoint'
import type { TurnResult } from '../packages/cli/src/turn-runtime'
import { drainLocalValidation, evidenceFor } from '../packages/cli/src/turn-validation'
import { gitText, writeJson } from '../packages/cli/src/turn-workspace'

const execute = promisify(execFile)
const root = fs.realpathSync(process.argv[2] ?? '')
if (!/^\/(?:private\/)?tmp\/supremo-[^/]+$/.test(root)) throw new Error('Use um scaffold descartável supremo-* em /tmp.')
if (fs.existsSync(path.join(root, '.git'))) throw new Error('O scaffold deve começar sem histórico Git.')
const PROJECT = crypto.randomUUID()
const status = (): { pid: number; url: string; healthy: boolean } => JSON.parse(execFileSync(process.execPath,
  ['scripts/preview.mjs', 'status'], { cwd: root, encoding: 'utf8' })) as { pid: number; url: string; healthy: boolean }
const before = status()
assert.equal(before.healthy, true)
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(before.url).hostname))
writeJson(path.join(root, '.supremo/project.json'), { projectId: PROJECT, supremoUrl: 'https://supremo.example.invalid' })
gitText(root, ['init', '-b', 'main'])
gitText(root, ['config', 'user.name', 'Supremo E2E'])
gitText(root, ['config', 'user.email', 'qa@example.invalid'])
gitText(root, ['remote', 'add', 'origin', 'https://github.com/fixture/fast-dev.git'])
gitText(root, ['add', '-A']); gitText(root, ['commit', '-m', 'Generated fixture'])
const initialHead = gitText(root, ['rev-parse', 'HEAD'])
const initialIndex = fs.readFileSync(path.join(root, '.git/index'))
const backendFile = path.join(root, '.supremo/turns/e2e-backend.json')
const backend: BackendTurnContext = { version: 1, projectId: PROJECT, project: { id: PROJECT, name: 'Fast dev' },
  repository: { fullName: 'fixture/fast-dev', url: 'https://github.com/fixture/fast-dev.git', branch: 'main', defaultBranch: 'main' },
  environment: 'development', databaseEnvironment: 'development',
  databaseAuthority: { projectRef: 'fixture', source: 'supremo_provisioned', automaticMigrations: true },
  latestCheckpoint: null, feedback: { current: null, previousFailure: null }, observedAt: new Date().toISOString() }
writeJson(backendFile, backend)
const runtimeFile = path.resolve('packages/cli/src/turn-runtime.ts')
const driverSource = path.join(root, '.supremo/turns/e2e-driver.ts')
const driver = path.join(root, '.supremo/turns/e2e-driver.cjs')
fs.writeFileSync(driverSource, `import {runTurnEvent} from ${JSON.stringify(runtimeFile)};
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
async function main() {
 const [root,event,session,prompt]=process.argv.slice(2);
 const output=await runTurnEvent(event,root,{session_id:session,prompt},'assisted',{
  reconcile:async()=>JSON.parse(fs.readFileSync(root+'/.supremo/turns/e2e-backend.json','utf8')),
  now:()=>new Date().toISOString(),
  ensureServices:()=>({preview:JSON.parse(execFileSync(process.execPath,['scripts/preview.mjs','status'],{cwd:root,encoding:'utf8'})),daemon:{running:true}})
 });
 console.log(JSON.stringify(output));
}
main().catch(e=>{console.error(e);process.exitCode=1});`)
buildSync({ entryPoints: [driverSource], outfile: driver, bundle: true, platform: 'node', target: 'node18', logLevel: 'silent' })
const call = async (event: string, session: string, prompt = ''): Promise<TurnResult> => {
  const result = await execute(process.execPath, [driver, root, event, session, prompt], { timeout: 20_000, maxBuffer: 4 * 1024 * 1024 })
  return JSON.parse(result.stdout) as TurnResult
}
const queue = () => defaultCheckpointDeps(root).readQueue()
const file = path.join(root, 'app/design-system/examples.tsx')
const original = fs.readFileSync(file, 'utf8')
const browser = await chromium.launch({ headless: true })
const measurements: Record<string, number> = {}
try {
  const page = await browser.newPage()
  await page.goto(`${before.url}/design-system`)
  await page.getByRole('heading', { name: 'Visão geral', exact: true }).waitFor()
  await page.getByLabel('Nome', { exact: false }).fill('Rascunho preservado')
  const start = performance.now()
  assert.equal((await call('preflight', 'first', 'Mude o título para Central de chamados.')).allowed, true)
  const firstSource = original.replace('>Visão geral</h1>', '>Central de chamados</h1>')
  assert.notEqual(firstSource, original)
  fs.writeFileSync(file, firstSource)
  await page.getByRole('heading', { name: 'Central de chamados', exact: true }).waitFor()
  measurements.firstVisibleMs = Math.round(performance.now() - start)
  assert.equal((await call('complete', 'first')).allowed, true)
  assert.equal(await drainLocalValidation(root), 1)
  const first = queue().at(-1)!
  assert.equal(first.validationStatus, 'deferred')
  assert.deepEqual(evidenceFor(root, first)?.checks.map(check => check.type), ['security'])
  assert.equal(await page.getByLabel('Nome', { exact: false }).inputValue(), 'Rascunho preservado')

  // Controlled remote failure, reproducing the user's old-selector problem.
  // This is not a claim that a real GitHub run was executed here.
  backend.latestCheckpoint = { id: first.checkpointId, localSha: first.commitSha, publishedSha: 'b'.repeat(40),
    pushStatus: 'published', integrationStatus: 'ci_failed', integrationBranch: 'supremo/integration', createdAt: first.createdAt }
  backend.feedback.current = { projectId: PROJECT, checkpointId: first.checkpointId, commitSha: first.commitSha,
    publishedSha: 'b'.repeat(40), observedAt: new Date().toISOString(), state: 'failed',
    failures: [{ name: 'browser E2E: outdated selector', category: 'code' }], summary: 'Seletor anterior não encontrado', evidence: 'Controlled fixture failure' }
  writeJson(backendFile, backend)
  const nextStart = performance.now()
  const cold = await call('preflight', 'new-conversation', 'Mostre a data e a hora de criação no título.')
  assert.equal(cold.allowed, true)
  assert.equal(cold.state?.turn.phase, 'work')
  assert.equal(cold.state?.context.developmentPolicy?.previousFailures, 'advisory')
  assert.equal(cold.state?.turn.recovery?.required, true, 'Unresolved evidence must remain visible')
  const dateTitle = 'Central de chamados · 06/09/2026 20:30'
  fs.writeFileSync(file, firstSource.replace('>Central de chamados</h1>', `>${dateTitle}</h1>`))
  await page.getByRole('heading', { name: dateTitle, exact: true }).waitFor()
  measurements.coldChangeVisibleMs = Math.round(performance.now() - nextStart)
  assert.equal((await call('complete', 'new-conversation')).allowed, true)
  await drainLocalValidation(root)
  assert.equal(queue().length, 2)
  assert.equal(queue().at(-1)?.validationStatus, 'deferred')
  assert.equal(await page.getByLabel('Nome', { exact: false }).inputValue(), 'Rascunho preservado')
  const after = status()
  assert.equal(after.pid, before.pid)
  assert.equal(after.url, before.url)
  assert.equal(gitText(root, ['rev-parse', 'HEAD']), initialHead)
  assert.deepEqual(fs.readFileSync(path.join(root, '.git/index')), initialIndex)
  console.log(JSON.stringify({ result: 'passed', scope: 'Generated app, real HMR/browser/Git/new OS processes; controlled backend/model boundaries',
    measurements, checkpointCount: queue().length, qa: 'not requested; only secret scan executed', previewPreserved: true,
    formDraftPreserved: true, oldFailurePreserved: true }, null, 2))
} finally {
  fs.writeFileSync(file, original)
  await browser.close()
}
