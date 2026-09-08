import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultCheckpointDeps, type CheckpointRecord } from './checkpoint'
import { readEnginePolicy } from './engine-policy'
import { drainAutoHeal, type RepairDeps } from './engine-repair'
import { runRepairProposal, type ProcessRunner } from './repair-runner'
import { drainLocalValidation, evidenceFor, requestCheckpointValidation, validateCheckpoint } from './turn-validation'
import * as processWorker from './worker-process'
import { captureTurnCheckpoint, gitText, readJson, writeJson } from './turn-workspace'
import * as workspace from './turn-workspace'
import { runWorkerProcess, WorkerAbortedError } from './worker-process'

// Protocol/process regressions use a small real validator; generated policy
// integrity is independently tested with the real bundled manifest.
vi.mock('./trusted-validation', () => ({ verifyTrustedFiles: () => {} }))
const PROJECT = '11111111-1111-4111-8111-111111111111'
let cwd: string
const verify = `import fs from 'node:fs'; import {execFileSync} from 'node:child_process';
const failed = !fs.readFileSync('src/card.ts','utf8').includes('value = 2');
const sha = execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
const base = process.argv[process.argv.indexOf('--base')+1];
fs.mkdirSync('.supremo',{recursive:true});
fs.writeFileSync('.supremo/verify-result.json',JSON.stringify({sha,base,status:failed?'failed':'passed',checks:[{name:'unit',type:'unit',status:failed?'failed':'passed'}]}));
if(failed) process.exit(1);
`
function capture(value: number): CheckpointRecord {
  fs.writeFileSync(path.join(cwd, 'src/card.ts'), `export const value = ${value};\n`)
  const record = captureTurnCheckpoint(cwd, { projectId: PROJECT, turnId: crypto.randomUUID(), summary: 'Fixture', environment: 'development' })
  if (!record) throw new Error('Missing checkpoint')
  return record
}
beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'supremo-engine-worker-'))
  gitText(cwd, ['init', '-b', 'main']); gitText(cwd, ['config', 'user.name', 'Fixture']); gitText(cwd, ['config', 'user.email', 'fixture@example.invalid'])
  fs.mkdirSync(path.join(cwd, 'src')); fs.mkdirSync(path.join(cwd, 'scripts'))
  fs.writeFileSync(path.join(cwd, '.gitignore'), '.supremo/turns/\n.supremo/validation/\n.supremo/checkpoints/\n')
  fs.writeFileSync(path.join(cwd, 'scripts/verify.mjs'), verify)
  fs.writeFileSync(path.join(cwd, 'src/card.ts'), 'export const value = 0;\n')
  gitText(cwd, ['add', '-A']); gitText(cwd, ['commit', '-m', 'fixture'])
})
afterEach(() => { fs.rmSync(cwd, { recursive: true, force: true }) })
const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

describe('bounded real OS workers', () => {
  it('kills the subprocess when aborted, including its descendant process group', async () => {
    const marker = path.join(cwd, 'survived')
    const controller = new AbortController()
    const childScript = path.join(cwd, 'descendant.cjs')
    fs.writeFileSync(childScript, "process.on('SIGTERM',()=>{});setTimeout(()=>require('node:fs').writeFileSync(process.argv[2],'bad'),1200)")
    const processCode = "require('node:child_process').spawn(process.execPath,process.argv.slice(1),{stdio:'ignore'});setInterval(()=>{},1000)"
    const running = runWorkerProcess(process.execPath, ['-e', processCode, childScript, marker], { cwd, timeoutMs: 4000, maxOutputBytes: 4096, signal: controller.signal })
    await wait(100); controller.abort()
    await expect(running).rejects.toBeInstanceOf(WorkerAbortedError)
    await wait(1300); expect(fs.existsSync(marker)).toBe(false)
  })
  it('enforces timeout and output budgets without invoking a shell', async () => {
    await expect(runWorkerProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd, timeoutMs: 50, maxOutputBytes: 4096 })).rejects.toThrow('tempo')
    await expect(runWorkerProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(10000));setInterval(()=>{},1000)'], { cwd, timeoutMs: 1000, maxOutputBytes: 4096 })).rejects.toThrow('saída')
    expect(fs.existsSync(path.join(cwd, 'pwned'))).toBe(false)
  })
})

describe('adaptive scheduling on immutable snapshots', () => {
  it('defaults to adaptive validation, debounces and prioritizes the latest checkpoint', async () => {
    expect(readEnginePolicy(cwd).validation_mode).toBe('background_adaptive')
    writeJson(path.join(cwd, '.supremo/lifecycle.json'), { validation: { debounce_ms: 250 } })
    const older = capture(1), newest = capture(2)
    expect(await drainLocalValidation(cwd)).toBe(0)
    expect(defaultCheckpointDeps(cwd).readQueue()[0]?.validationStatus).toBe('deferred')
    await wait(260)
    expect(await drainLocalValidation(cwd)).toBe(1)
    const queue = defaultCheckpointDeps(cwd).readQueue()
    expect(queue.at(-1)?.validationStatus).toBe('passed')
    expect(evidenceFor(cwd, queue.at(-1)!)?.sha).toBe(newest.commitSha)
    expect(readJson(path.join(cwd, '.supremo/validation/jobs', `${older.checkpointId}.json`))).toMatchObject({ status: 'superseded' })
    expect(await drainLocalValidation(cwd)).toBe(0)
  })
  it('cancels stale validation processes and schedules the new snapshot', async () => {
    fs.writeFileSync(path.join(cwd, 'scripts/verify.mjs'), `await new Promise(r=>setTimeout(r,1500));\n${verify}`)
    writeJson(path.join(cwd, '.supremo/lifecycle.json'), { validation: { debounce_ms: 250 } })
    const older = capture(1); await wait(260)
    const running = drainLocalValidation(cwd)
    await wait(100); const newer = capture(2)
    await running
    expect(readJson(path.join(cwd, '.supremo/validation/jobs', `${older.checkpointId}.json`))).toMatchObject({ status: 'superseded' })
    await wait(260); await drainLocalValidation(cwd)
    expect(defaultCheckpointDeps(cwd).readQueue().at(-1)).toMatchObject({ checkpointId: newer.checkpointId, validationStatus: 'passed' })
    expect(fs.readdirSync(path.join(cwd, '.supremo/validation')).filter(file => file.startsWith('work-'))).toEqual([])
  })
  it('reuses exact commit/base proof but executes again when the comparison base changes', async () => {
    writeJson(path.join(cwd, '.supremo/lifecycle.json'), { validation_mode: 'on_request' })
    const record = capture(2)
    const processSpy = vi.spyOn(processWorker, 'runWorkerProcess')
    try {
      requestCheckpointValidation(cwd, record); await drainLocalValidation(cwd)
      expect(processSpy).toHaveBeenCalledTimes(1)
      requestCheckpointValidation(cwd, record); await drainLocalValidation(cwd)
      expect(processSpy).toHaveBeenCalledTimes(1)
      requestCheckpointValidation(cwd, { ...record, changesetBaseSha: record.commitSha }); await drainLocalValidation(cwd)
      expect(processSpy).toHaveBeenCalledTimes(2)
    } finally { processSpy.mockRestore() }
  })
})

async function failingRecord(): Promise<CheckpointRecord> {
  writeJson(path.join(cwd, '.supremo/lifecycle.json'), { validation_mode: 'on_request', auto_heal: { runner: 'codex' } })
  const record = capture(1)
  const proof = await validateCheckpoint(cwd, record)
  expect(proof.status).toBe('failed')
  const failed = { ...record, validationStatus: 'failed' as const, validationId: proof.id, validatedSha: proof.sha }
  defaultCheckpointDeps(cwd).appendQueue(failed)
  return failed
}
function repairDeps(propose: RepairDeps['propose'] = async () => ({ summary: 'Fix value', files: [{ path: 'src/card.ts', content: 'export const value = 2;\n' }] })): RepairDeps {
  return { authorize: async () => {}, propose, trust: () => {}, validate: validateCheckpoint }
}
describe('actual isolated repair executor with controlled inference boundary', () => {
  it('repairs the app/ layout used by generated Supremo projects', async () => {
    fs.renameSync(path.join(cwd, 'src'), path.join(cwd, 'app'))
    fs.writeFileSync(path.join(cwd, 'scripts/verify.mjs'), verify.replace('src/card.ts', 'app/card.ts'))
    gitText(cwd, ['add', '-A']); gitText(cwd, ['commit', '-m', 'generated app layout'])
    writeJson(path.join(cwd, '.supremo/lifecycle.json'), { auto_heal: { runner: 'codex' } })
    fs.writeFileSync(path.join(cwd, 'app/card.ts'), 'export const value = 1;\n')
    const record = captureTurnCheckpoint(cwd, { projectId: PROJECT, turnId: crypto.randomUUID(), summary: 'App fixture', environment: 'development' })!
    const proof = await validateCheckpoint(cwd, record)
    defaultCheckpointDeps(cwd).appendQueue({ ...record, validationStatus: 'failed', validationId: proof.id, validatedSha: proof.sha })
    const propose = vi.fn<RepairDeps['propose']>(async (_runner, _dir, prompt) => {
      expect(prompt).toContain('app/card.ts')
      return { summary: 'Fix app', files: [{ path: 'app/card.ts', content: 'export const value = 2;\n' }] }
    })
    expect(await drainAutoHeal(cwd, undefined, repairDeps(propose))).toBe(1)
    expect(fs.readFileSync(path.join(cwd, 'app/card.ts'), 'utf8')).toContain('value = 2')
  })
  it('validates a candidate then applies and checkpoints without moving user HEAD/index', async () => {
    const failed = await failingRecord()
    const head = gitText(cwd, ['rev-parse', 'HEAD']), index = fs.readFileSync(path.join(cwd, '.git/index'))
    expect(await drainAutoHeal(cwd, undefined, repairDeps())).toBe(1)
    expect(fs.readFileSync(path.join(cwd, 'src/card.ts'), 'utf8')).toContain('value = 2')
    expect(gitText(cwd, ['rev-parse', 'HEAD'])).toBe(head)
    expect(fs.readFileSync(path.join(cwd, '.git/index'))).toEqual(index)
    const queue = defaultCheckpointDeps(cwd).readQueue()
    expect(queue).toHaveLength(2)
    expect(queue[0]?.validationStatus).toBe('failed')
    expect(queue[1]?.validationStatus).toBe('pending')
    expect(readJson(path.join(cwd, '.supremo/validation/repair', `${failed.checkpointId}.json`))).toMatchObject({ status: 'applied', attempts: 1 })
  })
  it('recovers a crash after applying the patch but before capture, without applying twice', async () => {
    await failingRecord()
    const captureSpy = vi.spyOn(workspace, 'captureTurnCheckpoint').mockImplementationOnce(() => { throw new Error('Simulated crash at capture boundary') })
    try { expect(await drainAutoHeal(cwd, undefined, repairDeps())).toBe(0) }
    finally { captureSpy.mockRestore() }
    expect(fs.readFileSync(path.join(cwd, 'src/card.ts'), 'utf8')).toContain('value = 2')
    expect(defaultCheckpointDeps(cwd).readQueue()).toHaveLength(1)
    expect(readJson(path.join(cwd, '.supremo/validation/repair/apply-journal.json'))).not.toBeNull()
    const propose = vi.fn<RepairDeps['propose']>(async () => { throw new Error('Must not reinvoke model during journal recovery') })
    expect(await drainAutoHeal(cwd, undefined, repairDeps(propose))).toBe(1)
    expect(await drainAutoHeal(cwd, undefined, repairDeps(propose))).toBe(0)
    expect(propose).not.toHaveBeenCalled()
    expect(defaultCheckpointDeps(cwd).readQueue()).toHaveLength(2)
    expect(readJson(path.join(cwd, '.supremo/validation/repair/apply-journal.json'))).toBeNull()
  })
  it.each(['tests/gate.test.ts', '../outside.ts', 'src/alias/card.ts'])('rejects protected/traversal/symlink proposal %s', async file => {
    await failingRecord()
    if (file.includes('alias')) { fs.mkdirSync(path.join(cwd, 'tests')); fs.symlinkSync('../tests', path.join(cwd, 'src/alias')); capture(3); const current = defaultCheckpointDeps(cwd).readQueue().at(-1)!; const proof = await validateCheckpoint(cwd, current); defaultCheckpointDeps(cwd).appendQueue({ ...current, validationStatus: 'failed', validationId: proof.id, validatedSha: proof.sha }) }
    const prior = fs.readFileSync(path.join(cwd, 'src/card.ts'), 'utf8')
    expect(await drainAutoHeal(cwd, undefined, repairDeps(async () => ({ summary: 'invalid', files: [{ path: file, content: 'disabled' }] })))).toBe(0)
    expect(fs.readFileSync(path.join(cwd, 'src/card.ts'), 'utf8')).toBe(prior)
    expect((readJson(path.join(cwd, '.supremo/validation/repair/status.json')) as { status: string }).status).toBe('failed')
  })
  it('does not overwrite edits made while the model proposal was in flight', async () => {
    await failingRecord()
    expect(await drainAutoHeal(cwd, undefined, repairDeps(async () => {
      fs.writeFileSync(path.join(cwd, 'src/card.ts'), 'export const value = 7;\n')
      return { summary: 'stale', files: [{ path: 'src/card.ts', content: 'export const value = 2;\n' }] }
    }))).toBe(0)
    expect(fs.readFileSync(path.join(cwd, 'src/card.ts'), 'utf8')).toContain('value = 7')
    expect(readJson(path.join(cwd, '.supremo/validation/repair/status.json'))).toMatchObject({ status: 'stale' })
  })
  it('never invokes inference while paused and stops retrying at the attempt budget', async () => {
    await failingRecord()
    writeJson(path.join(cwd, '.supremo/lifecycle.json'), { auto_heal: { runner: 'codex', paused: true, max_attempts: 1 } })
    const propose = vi.fn(async () => { throw new Error('model failure') })
    await drainAutoHeal(cwd, undefined, repairDeps(propose)); expect(propose).not.toHaveBeenCalled()
    writeJson(path.join(cwd, '.supremo/lifecycle.json'), { auto_heal: { runner: 'codex', max_attempts: 1 } })
    await drainAutoHeal(cwd, undefined, repairDeps(propose)); await drainAutoHeal(cwd, undefined, repairDeps(propose))
    expect(propose).toHaveBeenCalledTimes(1)
    expect(readJson(path.join(cwd, '.supremo/validation/repair/status.json'))).toMatchObject({ status: 'exhausted', attempts: 1 })
  })
  it('inherits exhausted attempts across repair-produced checkpoints instead of looping forever', async () => {
    const parent = await failingRecord()
    const next = capture(3)
    const proof = await validateCheckpoint(cwd, next)
    defaultCheckpointDeps(cwd).appendQueue({ ...next, validationStatus: 'failed', validationId: proof.id, validatedSha: proof.sha })
    writeJson(path.join(cwd, '.supremo/validation/repair', `${parent.checkpointId}.json`), {
      checkpointId: parent.checkpointId, sha: parent.commitSha, attempts: 2, status: 'applied', updatedAt: Date.now(), reason: 'Fixture repair lineage', resultCheckpointId: next.checkpointId,
    })
    const propose = vi.fn<RepairDeps['propose']>(async () => { throw new Error('Must not spend another attempt') })
    expect(await drainAutoHeal(cwd, undefined, repairDeps(propose))).toBe(0)
    expect(propose).not.toHaveBeenCalled()
    expect(readJson(path.join(cwd, '.supremo/validation/repair/status.json'))).toMatchObject({ status: 'exhausted', attempts: 2 })
  })
})

describe('provider invocation permissions and budgets', () => {
  it.each(['symlink', 'growing'])('Codex refuses %s proposal output before accepting JSON', async (kind) => {
    const proposal = JSON.stringify({ summary: 'fix', files: [{ path: 'src/card.ts', content: 'fixed' }] })
    const fake: ProcessRunner = async (_executable, args) => {
      if (args.includes('mcp')) return { stdout: '[]', stderr: '' }
      const output = args[args.indexOf('--output-last-message') + 1]!
      if (kind === 'symlink') {
        fs.writeFileSync(path.join(cwd, 'untrusted-proposal'), proposal)
        fs.symlinkSync('untrusted-proposal', output)
      } else {
        fs.writeFileSync(output, proposal)
        const fstat = fs.fstatSync
        vi.spyOn(fs, 'fstatSync').mockImplementationOnce((fd) => {
          const stat = fstat(fd)
          fs.appendFileSync(output, ' '.repeat(readEnginePolicy(cwd).auto_heal.max_output_bytes))
          return stat
        })
      }
      return { stdout: '', stderr: '' }
    }
    try { await expect(runRepairProposal('codex', cwd, 'Fixture', readEnginePolicy(cwd).auto_heal, undefined, fake)).rejects.toThrow() }
    finally { vi.restoreAllMocks() }
  })
  it('Codex narrows native tools and all configured MCP servers, uses read-only and schema output', async () => {
    const calls: string[][] = []
    const fake: ProcessRunner = async (_executable, args) => {
      calls.push([...args])
      if (args.includes('mcp')) return { stdout: JSON.stringify([{ name: 'github', enabled: args[0] === 'mcp', transport: { type: 'streamable_http' } }]), stderr: '' }
      fs.writeFileSync(args[args.indexOf('--output-last-message') + 1]!, JSON.stringify({ summary: 'fix', files: [{ path: 'src/card.ts', content: 'fixed' }] }))
      return { stdout: '', stderr: '' }
    }
    const result = await runRepairProposal('codex', cwd, 'Fixture proposal only', readEnginePolicy(cwd).auto_heal, undefined, fake)
    expect(result.files[0]?.path).toBe('src/card.ts')
    expect(calls[2]).toEqual(expect.arrayContaining(['read-only', 'approval_policy="never"', 'features.shell_tool=false', 'mcp_servers.github.enabled=false']))
    expect(calls.flat().join(' ')).not.toMatch(/dangerously|bypass|ignore-rules/)
  })
  it('Claude denies built-in and MCP tools and supplies its native spend cap', async () => {
    const fake = vi.fn<ProcessRunner>(async () => ({ stdout: JSON.stringify({ structured_output: { summary: 'fix', files: [{ path: 'src/card.ts', content: 'fixed' }] } }), stderr: '' }))
    await runRepairProposal('claude', cwd, 'Fixture', readEnginePolicy(cwd).auto_heal, undefined, fake)
    expect(fake.mock.calls[0]?.[1]).toEqual(expect.arrayContaining(['--restricted', '--tools', '', '--disallowedTools', 'mcp__*', '--max-budget-usd', '2']))
  })
  it('refuses inference when a provider leaves an external MCP enabled', async () => {
    const fake = vi.fn<ProcessRunner>(async () => ({ stdout: JSON.stringify([{ name: 'github', enabled: true, transport: { type: 'streamable_http' } }]), stderr: '' }))
    await expect(runRepairProposal('codex', cwd, 'Fixture', readEnginePolicy(cwd).auto_heal, undefined, fake)).rejects.toThrow('todos os MCPs')
    expect(fake.mock.calls).toHaveLength(2)
    expect(fake.mock.calls.every(call => !call[1].includes('exec'))).toBe(true)
  })
})
