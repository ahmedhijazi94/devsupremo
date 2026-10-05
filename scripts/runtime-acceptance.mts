/** Opt-in local process acceptance; no real account, keychain, preview or service.
 * Run: npx tsx scripts/runtime-acceptance.mts
 * Requires a current CLI build. Stores a bounded JSON proof under the OS tmpdir.
 * Provider/control-plane responses are fixtures; filesystem, Git, updater,
 * CLI, daemon, SIGSTOP/SIGKILL, HTTP preview and receipt reads are real.
 */
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { build } from 'esbuild'
import { buildProjectFiles } from '../src/lib/templates/project-files'
import { packCli } from '../src/lib/bootstrap/cli-artifact'
import { gitText, captureTurnCheckpoint, writeJson, readJson } from '../packages/cli/src/turn-workspace'
import { enqueueDatabaseOperation, drainDurableOperations, operationStatus } from '../packages/cli/src/durable-operations'
import { blobHash } from '../packages/cli/src/validation-integrity'
import { inspectManagedDaemon } from '../packages/cli/src/daemon-lifecycle'

const repo = process.cwd(), temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'supremo-runtime-acceptance-'))
const children: ChildProcess[] = [], daemonPids = new Set<number>(), samples: Record<string, number[]> = {}
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const until = async (check: () => boolean, detail: string, timeout = 20_000) => {
  const deadline = Date.now() + timeout
  while (!check()) { if (Date.now() >= deadline) throw new Error(`Timeout: ${detail}`); await pause(15) }
}
const record = (name: string, start: number) => (samples[name] ??= []).push(performance.now() - start)
const proof: Record<string, unknown> = { at: new Date().toISOString(), platform: process.platform, node: process.version,
  boundaries: { real: ['Git/filesystem', 'old/current CLI', 'updater and daemon processes', 'preview HTTP process', 'signals and journal recovery'],
    fixtures: ['control plane and provider responses', 'OS keychain adapter'], modelLatency: 'not measured: no model or external provider invoked', realSleepResume: false, launchdInstalled: false } }
const newBundle = fs.readFileSync(path.join(repo, 'packages/cli/dist/bin.js'), 'utf8')
const release = packCli('1.14.0', newBundle), releaseDigest = crypto.createHash('sha256').update(release).digest('hex')
const candidates = new Map<string, { projectId: string; revision: string; cliDigest: string; templateVersion: string; baseSha: string; files: { path: string; content: string; beforeBlob: string }[] }>()
let issuer = ''
const requests: string[] = []
const control = http.createServer(async (request, response) => {
  requests.push(request.url ?? '')
  let raw = ''; for await (const chunk of request) raw += String(chunk)
  const input = raw ? JSON.parse(raw) as { projectId?: string; operation?: string } : {}
  response.setHeader('Content-Type', 'application/json')
  if (request.url === '/api/cli/release') { response.end(JSON.stringify({ version: '1.14.0', digest: releaseDigest, url: `/api/cli/${releaseDigest}.tgz`, queueProtocol: 2, protocol: 2, minimumCli: '1.14.0' })); return }
  if (request.url === `/api/cli/${releaseDigest}.tgz`) { response.end(release); return }
  if (request.url === '/api/cli/candidate') {
    const candidate = candidates.get(input.projectId ?? '')
    response.end(JSON.stringify(input.operation === 'authorize' ? { projectId: input.projectId, revision: candidate?.revision } : candidate)); return
  }
  response.statusCode = 401; response.end(JSON.stringify({ error: 'Synthetic control plane: writes disabled' }))
})
const preload = path.join(temporary, 'fixture-preload.cjs')
fs.writeFileSync(preload, `const child = require('node:child_process'); const fs = require('node:fs');
const originalExec = child.execFileSync;
child.execFileSync = function(file, args, options) {
  if (process.env.SUPREMO_FIXTURE_TRACE) fs.appendFileSync(process.env.SUPREMO_FIXTURE_TRACE, String(file)+'\\n');
  if (/osascript|secret-tool/.test(String(file))) return JSON.stringify({version:1,projectId:process.env.SUPREMO_FIXTURE_PROJECT,issuer:process.env.SUPREMO_FIXTURE_ISSUER,secret:'fixture-authorization'});
  return originalExec.apply(this, arguments);
};
const rename = fs.renameSync;
fs.renameSync = function(from, to) {
  const result = rename.apply(this, arguments);
  if (process.env.SUPREMO_FIXTURE_INTERRUPT === '1' && String(to).endsWith('/tools/supremo-cli/dist/bin.js')) {
    fs.writeFileSync('.supremo/runtime-update/interrupted', String(process.pid)); process.kill(process.pid, 'SIGSTOP');
  }
  return result;
};\n`)
const cli = async (cwd: string, projectId: string, args: string[], interrupt = false) => {
  const child = spawn(process.execPath, [path.join(repo, 'packages/cli/dist/bin.js'), ...args], { cwd,
    env: { ...process.env, NODE_OPTIONS: `--require=${preload}`, SUPREMO_FIXTURE_PROJECT: projectId, SUPREMO_FIXTURE_ISSUER: issuer, SUPREMO_FIXTURE_INTERRUPT: interrupt ? '1' : '0', SUPREMO_FIXTURE_TRACE: path.join(temporary, 'trace.log') },
    stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(child)
  let stdout = '', stderr = ''
  child.stdout!.on('data', chunk => { stdout += String(chunk) }); child.stderr!.on('data', chunk => { stderr += String(chunk) })
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => { child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr })) })
  return { child, done, output: () => ({ stdout, stderr }) }
}
try {
  await new Promise<void>(resolve => control.listen(0, '127.0.0.1', resolve))
  issuer = `http://127.0.0.1:${(control.address() as import('node:net').AddressInfo).port}`
  const archive = path.join(temporary, 'old-source'); fs.mkdirSync(archive)
  execFileSync('tar', ['-xf', '-', '-C', archive], { input: execFileSync('git', ['archive', 'HEAD', 'packages/cli', 'src/lib'], { cwd: repo, maxBuffer: 128 * 1024 * 1024 }) })
  const oldOutput = path.join(temporary, 'old-cli.cjs')
  await build({ absWorkingDir: archive, entryPoints: ['packages/cli/src/bin.ts'], outfile: oldOutput, bundle: true, platform: 'node', target: 'node18', supported: { 'template-literal': false },
    nodePaths: [path.join(repo, 'node_modules'), path.join(repo, 'packages/cli/node_modules')], alias: { zod: path.join(repo, 'packages/cli/node_modules/zod/index.js') }, logLevel: 'silent' })
  const oldVersion = execFileSync(process.execPath, [oldOutput, '--version'], { encoding: 'utf8' }).trim()
  assert.equal(oldVersion, '1.13.0'); proof.oldVersion = oldVersion
  for (const generation of ['old', 'new'] as const) {
    const cwd = path.join(temporary, generation), projectId = crypto.randomUUID(); fs.mkdirSync(cwd)
    for (const file of buildProjectFiles({ projectName: `acceptance-${generation}`, description: '', projectId, stack: 'nextjs', kind: 'solo' })) {
      fs.mkdirSync(path.dirname(path.join(cwd, file.path)), { recursive: true }); fs.writeFileSync(path.join(cwd, file.path), file.content)
    }
    const tools = path.join(cwd, 'tools/supremo-cli')
    const candidateLock = fs.readFileSync(path.join(cwd, 'package-lock.json'), 'utf8')
    if (generation === 'old') {
      fs.writeFileSync(path.join(tools, 'dist/bin.js'), fs.readFileSync(oldOutput))
      fs.writeFileSync(path.join(tools, 'package.json'), JSON.stringify({ name: 'supremo-cli', version: oldVersion, bin: { supremo: 'dist/bin.js' }, engines: { node: '>=18' } }))
      const lock = JSON.parse(candidateLock) as { packages: Record<string, { version?: string }> }
      lock.packages['tools/supremo-cli']!.version = oldVersion
      fs.writeFileSync(path.join(cwd, 'package-lock.json'), JSON.stringify(lock, null, 2) + '\n')
    }
    fs.mkdirSync(path.join(cwd, 'node_modules/.bin'), { recursive: true }); fs.symlinkSync(tools, path.join(cwd, 'node_modules/supremo-cli'))
    fs.symlinkSync(path.join(tools, 'dist/bin.js'), path.join(cwd, 'node_modules/.bin/supremo'))
    writeJson(path.join(cwd, '.supremo/project.json'), { projectId, supremoUrl: issuer, stack: 'nextjs' })
    writeJson(path.join(cwd, '.supremo/lifecycle.json'), { validation_mode: 'on_request' })
    fs.appendFileSync(path.join(cwd, 'AGENTS.md'), '\nPersonal instruction to preserve.\n')
    gitText(cwd, ['init', '-b', 'main']); gitText(cwd, ['config', 'user.name', 'Acceptance']); gitText(cwd, ['config', 'user.email', 'acceptance@example.invalid'])
    gitText(cwd, ['add', '-A']); gitText(cwd, ['commit', '-m', 'synthetic project'])
    const beforeInstructions = fs.readFileSync(path.join(cwd, 'AGENTS.md'), 'utf8')
    candidates.set(projectId, { projectId, revision: crypto.randomUUID(), cliDigest: releaseDigest, templateVersion: '4.0.18', baseSha: gitText(cwd, ['rev-parse', 'HEAD']),
      files: [{ path: 'AGENTS.md', content: beforeInstructions + '\nNew engine instructions.\n', beforeBlob: blobHash(beforeInstructions) },
        ...(generation === 'old' ? [{ path: 'package-lock.json', content: candidateLock, beforeBlob: blobHash(fs.readFileSync(path.join(cwd, 'package-lock.json'), 'utf8')) }] : [])] })
    fs.writeFileSync(path.join(cwd, 'app/personal-draft.ts'), 'export const draft = true;\n')
    const head = gitText(cwd, ['rev-parse', 'HEAD']), index = gitText(cwd, ['write-tree'])
    const preview = spawn(process.execPath, ['-e', "require('http').createServer((q,s)=>s.end('preview remains healthy')).listen(0,'127.0.0.1',function(){console.log(this.address().port)})"], { cwd, stdio: ['ignore', 'pipe', 'pipe'] }); children.push(preview)
    let port = 0; preview.stdout!.on('data', data => { port = Number(String(data).trim()) }); await until(() => port > 0, 'preview startup')
    const previewUrl = `http://127.0.0.1:${port}`, previewPid = preview.pid
    const checkpoint = captureTurnCheckpoint(cwd, { projectId, turnId: crypto.randomUUID(), summary: 'Draft before runtime update', environment: 'development' })
    assert.ok(checkpoint)
    const receiptId = enqueueDatabaseOperation(cwd, 'status', {})
    if (generation === 'old') {
      const previous = spawn(process.execPath, [path.join(cwd, 'node_modules/.bin/supremo'), 'daemon'], { cwd,
        env: { ...process.env, NODE_OPTIONS: `--require=${preload}`, SUPREMO_FIXTURE_PROJECT: projectId, SUPREMO_FIXTURE_ISSUER: issuer }, stdio: 'ignore' }); children.push(previous)
      writeJson(path.join(cwd, '.supremo/checkpoints/daemon.pid'), previous.pid); daemonPids.add(previous.pid!)
      await until(() => fs.existsSync(path.join(cwd, '.supremo/database-queue/heartbeat')), 'old daemon heartbeat')
      const identity = await inspectManagedDaemon(cwd, previous.pid!, [path.join(cwd, 'node_modules/.bin/supremo')])
      if (!identity) throw new Error(`Fixture daemon identity not verified: ${execFileSync('/bin/ps', ['-ww', '-p', String(previous.pid), '-o', 'args='], { encoding: 'utf8' }).trim()} cwd=${execFileSync('/usr/sbin/lsof', ['-a', '-p', String(previous.pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8' }).trim()}`)
    }
    const start = performance.now(), update = await cli(cwd, projectId, ['runtime', 'update'], generation === 'old')
    if (generation === 'old') {
      const marker = path.join(cwd, '.supremo/runtime-update/interrupted')
      try { await until(() => fs.existsSync(marker) || update.child.exitCode !== null, 'interrupted update after file swap', 60_000) }
      catch (error) {
        const directory = path.dirname(marker)
        const state = fs.existsSync(directory) ? fs.readdirSync(directory).filter(file => /^[a-f0-9-]{36}\.json$/.test(file)).map(file => {
          const plan = readJson(path.join(directory, file)) as { status?: string; error?: string }; return { status: plan.status, error: plan.error }
        }) : []
        throw new Error(`${String(error)} ${JSON.stringify({ ...update.output(), state, requests: requests.slice(-12), trace: fs.existsSync(path.join(temporary, 'trace.log')) ? fs.readFileSync(path.join(temporary, 'trace.log'), 'utf8').slice(-500) : '' })}`)
      }
      if (!fs.existsSync(marker)) {
        const value = await update.done
        const pid = Number(fs.readFileSync(path.join(cwd, '.supremo/checkpoints/daemon.pid'), 'utf8'))
        const identity = await inspectManagedDaemon(cwd, pid, [path.join(cwd, 'node_modules/.bin/supremo')])
        throw new Error(`${value.stderr || 'Update exited before interruption'} ${JSON.stringify({ pid, identity })}`)
      }
      const plans = fs.readdirSync(path.dirname(marker)).filter(file => /^[a-f0-9-]{36}\.json$/.test(file))
      assert.equal(plans.length, 1)
      const plan = readJson(path.join(path.dirname(marker), plans[0]!)) as { id: string; status: string }
      assert.equal(plan.status, 'applying')
      assert.equal(await (await fetch(previewUrl)).text(), 'preview remains healthy')
      update.child.kill('SIGKILL'); await update.done
      const resumed = await cli(cwd, projectId, ['runtime', 'apply-update', plan.id]), result = await resumed.done
      assert.equal(result.code, 0, result.stderr); assert.equal(JSON.parse(result.stdout).status, 'active')
    } else {
      const result = await update.done; assert.equal(result.code, 0, result.stderr); assert.equal(JSON.parse(result.stdout).status, 'active')
    }
    record(`${generation}_update_ms`, start)
    const active = await (await cli(cwd, projectId, ['runtime', 'status'])).done
    const status = JSON.parse(active.stdout) as { compatible: boolean; active: { pid: number; version: string } }
    assert.equal(status.compatible, true); assert.equal(status.active.version, '1.14.0'); daemonPids.add(status.active.pid)
    assert.equal(preview.pid, previewPid); assert.equal(await (await fetch(previewUrl)).text(), 'preview remains healthy')
    assert.equal(gitText(cwd, ['rev-parse', 'HEAD']), head); assert.equal(gitText(cwd, ['write-tree']), index)
    assert.ok(fs.readFileSync(path.join(cwd, 'AGENTS.md'), 'utf8').includes('Personal instruction to preserve.'))
    assert.equal(fs.readFileSync(path.join(cwd, 'app/personal-draft.ts'), 'utf8'), 'export const draft = true;\n')
    assert.ok(fs.readFileSync(path.join(cwd, '.supremo/checkpoints/queue.jsonl'), 'utf8').includes(checkpoint.checkpointId))
    assert.ok(operationStatus(cwd, receiptId))
    process.kill(status.active.pid, 'SIGSTOP'); await pause(200)
    assert.equal(await (await fetch(previewUrl)).text(), 'preview remains healthy')
    process.kill(status.active.pid, 'SIGCONT')
    proof[generation] = { cliActive: status.active.version, previewSamePidPort: true, headAndIndexPreserved: true, draftAndInstructionsPreserved: true,
      checkpointAndReceiptRetained: true, interruptedAndResumed: generation === 'old', stoppedAndContinuedDaemon: true }
    // Stop only the fixture daemon before measuring engine-only warm paths.
    process.kill(status.active.pid, 'SIGTERM'); await pause(400)
    for (let i = 0; i < 30; i++) {
      let mark = performance.now(); const id = enqueueDatabaseOperation(cwd, 'status', {}); record('warm_enqueue_ms', mark)
      mark = performance.now(); await drainDurableOperations(cwd, async () => ({ ready: true })); record('warm_queue_local_ms', mark)
      mark = performance.now(); operationStatus(cwd, id); record('warm_receipt_ms', mark)
      fs.writeFileSync(path.join(cwd, 'app/personal-draft.ts'), `export const draft = ${i};\n`)
      mark = performance.now(); captureTurnCheckpoint(cwd, { projectId, turnId: crypto.randomUUID(), summary: 'Synthetic capture sample', environment: 'development' }); record('warm_capture_ms', mark)
    }
  }
  proof.timings = Object.fromEntries(Object.entries(samples).map(([name, values]) => [name, values.length === 1
    ? { n: 1, duration: +values[0]!.toFixed(2), unit: 'ms' }
    : { n: values.length, p50: +[...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!.toFixed(2), p95: +[...values].sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1]!.toFixed(2), unit: 'ms' }]))
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'supremo-runtime-proof-'))
  const output = path.join(outputDirectory, 'acceptance.json')
  fs.writeFileSync(output, JSON.stringify(proof, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); console.log(JSON.stringify({ proof: output, ...proof }, null, 2))
} finally {
  for (const child of children) if (child.exitCode === null) { try { child.kill('SIGKILL') } catch { /* fixture already exited */ } }
  for (const pid of daemonPids) { try { process.kill(pid, 'SIGKILL') } catch { /* fixture already exited */ } }
  await new Promise<void>(resolve => control.close(() => resolve()))
  fs.rmSync(temporary, { recursive: true, force: true })
}
