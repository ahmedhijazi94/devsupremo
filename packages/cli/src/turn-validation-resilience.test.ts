import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { defaultCheckpointDeps, type CheckpointRecord } from './checkpoint'
import { enginePolicySchema, readEnginePolicy } from './engine-policy'
import { drainLocalValidation, evidenceFor, requestCheckpointValidation, validateCheckpoint, type LocalEvidence } from './turn-validation'
import { captureTurnCheckpoint, gitText, readJson, writeJson } from './turn-workspace'
import * as processWorker from './worker-process'
import { runWorkerProcess, WorkerAbortedError, WorkerInfrastructureError, WorkerOutputLimitError } from './worker-process'

vi.mock('./trusted-validation', () => ({ verifyTrustedFiles: () => {} }))
// These fixtures launch real OS processes and remain bounded under parallel CI load.
vi.setConfig({ testTimeout: 20_000 })
const realRunWorker = runWorkerProcess
const PROJECT = '11111111-1111-4111-8111-111111111111'
let cwd: string
const prelude = `import fs from 'node:fs'; import { execFileSync } from 'node:child_process';
const sha = execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
const base = process.argv[process.argv.indexOf('--base')+1];
fs.mkdirSync('.supremo',{recursive:true});
const save = (name,value) => fs.writeFileSync('.supremo/'+name,JSON.stringify(value));
`
const passing = `save('verify-result.json',{sha,base,status:'passed',checks:[{name:'typecheck',status:'passed'}]});`
const stageTimeout = `save('verify-result.json',{sha,base,status:'failed',failureReason:'timeout',checks:[{name:'typecheck',type:'typecheck',status:'failed',failureReason:'timeout'}]}); process.exit(1);`
function capture(script = passing): CheckpointRecord {
  fs.writeFileSync(path.join(cwd, 'scripts/verify.mjs'), prelude + script)
  fs.writeFileSync(path.join(cwd, 'src/card.ts'), `export const value = 2;\n`)
  const record = captureTurnCheckpoint(cwd, { projectId: PROJECT, turnId: crypto.randomUUID(), summary: 'Resilience fixture', environment: 'development' })!
  const ready = { ...record, createdAt: new Date(Date.now() - 60_000).toISOString() }
  defaultCheckpointDeps(cwd).appendQueue(ready)
  return ready
}
function latestEvidence(): LocalEvidence | null {
  return evidenceFor(cwd, defaultCheckpointDeps(cwd).readQueue().at(-1)!)
}
function stateFiles(): string[] { return fs.readdirSync(path.join(cwd, '.supremo/validation/attempts')).map(file => path.join(cwd, '.supremo/validation/attempts', file)) }
function smallTimeout(): MockInstance<typeof runWorkerProcess> {
  return vi.spyOn(processWorker, 'runWorkerProcess').mockImplementation((bin, args, options) => realRunWorker(bin, args, { ...options, timeoutMs: 2000 }))
}
beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'supremo-validation-resilience-'))
  gitText(cwd, ['init', '-b', 'main']); gitText(cwd, ['config', 'user.name', 'Fixture']); gitText(cwd, ['config', 'user.email', 'fixture@example.invalid'])
  fs.mkdirSync(path.join(cwd, 'scripts')); fs.mkdirSync(path.join(cwd, 'src'))
  fs.writeFileSync(path.join(cwd, '.gitignore'), '.supremo/validation/\n.supremo/turns/\n.supremo/checkpoints/\n.next/\n')
  fs.writeFileSync(path.join(cwd, 'src/card.ts'), 'export const value = 0;\n')
  gitText(cwd, ['add', '-A']); gitText(cwd, ['commit', '-m', 'fixture'])
  writeJson(path.join(cwd, '.supremo/lifecycle.json'), { validation: { debounce_ms: 250, retry_backoff_ms: 1000 } })
})
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(cwd, { recursive: true, force: true }) })

describe('structured interruption evidence', () => {
  it('never captures progress artifacts, including previously tracked reports and atomic write temporaries', () => {
    const progress = path.join(cwd, '.supremo/verify-progress.json')
    fs.writeFileSync(progress, '{"private":"runtime only"}')
    fs.writeFileSync(`${progress}.123.tmp`, 'interrupted write')
    gitText(cwd, ['add', '.supremo/verify-progress.json'])
    gitText(cwd, ['commit', '-m', 'accidentally tracked report'])
    const record = capture()
    const files = gitText(cwd, ['ls-tree', '-r', '--name-only', record.commitSha])
    expect(files).not.toContain('verify-progress')
    expect(fs.readFileSync(progress, 'utf8')).toBe('{"private":"runtime only"}')
  })
  it('uses a ten minute default while preserving explicit limits and bounded retries', () => {
    expect(readEnginePolicy(cwd).validation).toMatchObject({ timeout_ms: 600_000, max_attempts: 2, retry_backoff_ms: 1000 })
    expect(enginePolicySchema.parse({ validation: { timeout_ms: 180_000 } }).validation.timeout_ms).toBe(180_000)
    expect(enginePolicySchema.safeParse({ validation: { max_attempts: 4 } }).success).toBe(false)
    expect(enginePolicySchema.safeParse({ validation: { retry_backoff_ms: 0 } }).success).toBe(false)
  })
  it('returns typed timeout/output errors with captured subprocess diagnostics', async () => {
    await expect(realRunWorker(process.execPath, ['-e', "process.stderr.write('diagnostic');setInterval(()=>{},1000)"],
      { cwd, timeoutMs: 2000, maxOutputBytes: 4096 })).rejects.toMatchObject({ name: 'WorkerTimeoutError', reason: 'timeout', timeoutMs: 2000, stderr: 'diagnostic' })
    await expect(realRunWorker(process.execPath, ['-e', "process.stdout.write('x'.repeat(5000));setInterval(()=>{},1000)"],
      { cwd, timeoutMs: 5000, maxOutputBytes: 4096 })).rejects.toBeInstanceOf(WorkerOutputLimitError)
  })
  it('preserves partial completed checks and the interrupted stage, without changing the preview', async () => {
    const record = capture(`save('verify-progress.json',{version:1,sha,base,status:'running',checks:[{name:'typecheck',type:'typecheck',status:'passed'}],activeChecks:[{name:'unit',type:'unit',startedAt:new Date().toISOString()}]});
      process.stderr.write('token=privatefixturevalue');setInterval(()=>{},1000);`)
    smallTimeout()
    const head = gitText(cwd, ['rev-parse', 'HEAD']), index = fs.readFileSync(path.join(cwd, '.git/index'))
    fs.mkdirSync(path.join(cwd, '.next')); fs.writeFileSync(path.join(cwd, '.next/healthy'), 'preview')
    const evidence = await validateCheckpoint(cwd, record)
    expect(evidence).toMatchObject({ status: 'failed', failureReason: 'timeout', checks: [
      { name: 'typecheck', type: 'typecheck', status: 'passed' },
      { name: 'unit', type: 'external_dependency', status: 'failed', failureReason: 'timeout' },
    ] })
    expect(evidence.logs).toContain('Etapas interrompidas: unit')
    expect(evidence.logs).not.toContain('privatefixturevalue')
    expect(gitText(cwd, ['rev-parse', 'HEAD'])).toBe(head); expect(fs.readFileSync(path.join(cwd, '.git/index'))).toEqual(index)
    expect(fs.readFileSync(path.join(cwd, '.next/healthy'), 'utf8')).toBe('preview')
    expect(fs.readdirSync(path.join(cwd, '.supremo/validation')).some(file => file.startsWith('work-'))).toBe(false)
  })
  it('cannot accept a passing report when its process actually times out', async () => {
    const record = capture(passing + 'setInterval(()=>{},1000);')
    smallTimeout()
    expect(await validateCheckpoint(cwd, record)).toMatchObject({ status: 'failed', failureReason: 'timeout', checks: [
      { name: 'typecheck', status: 'passed' }, { name: 'validation infrastructure', type: 'external_dependency', status: 'failed', failureReason: 'timeout' },
    ] })
  })
  it('cannot accept completed-looking progress without a final report', async () => {
    const record = capture("save('verify-progress.json',{version:1,sha,base,status:'passed',checks:[{name:'typecheck',status:'passed'}],activeChecks:[]});")
    expect(await validateCheckpoint(cwd, record)).toMatchObject({ status: 'failed', failureReason: 'invalid_evidence', checks: [
      { name: 'typecheck', status: 'passed' }, { name: 'validation infrastructure', type: 'external_dependency', status: 'failed' },
    ] })
  })
  it.each(['wrong-sha', 'malformed', 'symlink', 'duplicate'] as const)('rejects %s progress without retrying even after a real timeout', async scenario => {
    const script = scenario === 'malformed' ? "fs.writeFileSync('.supremo/verify-progress.json','not json');"
      : scenario === 'symlink' ? "fs.symlinkSync('../src/card.ts','.supremo/verify-progress.json');"
      : `save('verify-progress.json',{version:1,sha:${scenario === 'wrong-sha' ? "'a'.repeat(40)" : 'sha'},base,status:'running',checks:[{name:'typecheck',status:'passed'}],activeChecks:${scenario === 'duplicate' ? "[{name:'typecheck',startedAt:new Date().toISOString()}]" : '[]'}});`
    capture(script + 'setInterval(()=>{},1000);')
    const worker = smallTimeout()
    await drainLocalValidation(cwd)
    expect(latestEvidence()).toMatchObject({ status: 'failed', failureReason: 'invalid_evidence' })
    expect(worker).toHaveBeenCalledTimes(1)
  })
  it('keeps code failure authoritative when a parallel stage is interrupted', async () => {
    capture(`save('verify-progress.json',{version:1,sha,base,status:'running',checks:[{name:'typecheck',type:'typecheck',status:'failed',failureReason:'code'}],activeChecks:[{name:'unit',type:'unit',startedAt:new Date().toISOString()}]}); setInterval(()=>{},1000);`)
    const worker = smallTimeout()
    await drainLocalValidation(cwd)
    expect(latestEvidence()).toMatchObject({ status: 'failed', failureReason: 'code' })
    expect(worker).toHaveBeenCalledTimes(1)
  })
})

describe('bounded retry and durable launch accounting', () => {
  it('automatically retries a stage timeout once, preserving its real type as infrastructure', async () => {
    capture(stageTimeout)
    const worker = vi.spyOn(processWorker, 'runWorkerProcess')
    await drainLocalValidation(cwd)
    expect(worker).toHaveBeenCalledTimes(2)
    expect(latestEvidence()).toMatchObject({ status: 'failed', failureReason: 'timeout', checks: [{ name: 'typecheck', type: 'external_dependency', failureReason: 'timeout' }] })
    expect(readJson(stateFiles()[0]!)).toMatchObject({ attempts: 2, status: 'completed' })
    expect(fs.existsSync(path.join(cwd, '.supremo/validation/cache'))).toBe(false)
    expect(await drainLocalValidation(cwd)).toBe(0)
  })
  it('retries a transient resource failure and then records a completed success', async () => {
    capture()
    const worker = vi.spyOn(processWorker, 'runWorkerProcess').mockRejectedValueOnce(new WorkerInfrastructureError('EAGAIN'))
    await drainLocalValidation(cwd)
    expect(worker).toHaveBeenCalledTimes(2)
    expect(latestEvidence()?.status).toBe('passed')
    expect(readJson(stateFiles()[0]!)).toMatchObject({ attempts: 2, status: 'completed' })
  })
  it.each(['code', 'security', 'missing-executable', 'output', 'malformed'] as const)('does not automatically retry %s failures', async scenario => {
    capture(scenario === 'malformed' ? "fs.writeFileSync('.supremo/verify-result.json','{bad');process.exit(1);"
      : `save('verify-result.json',{sha,base,status:'failed',checks:[{name:'${scenario}',type:'${scenario === 'security' ? 'security' : 'unit'}',status:'failed'}]});process.exit(1);`)
    const worker = vi.spyOn(processWorker, 'runWorkerProcess')
    if (scenario === 'missing-executable') worker.mockRejectedValueOnce(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }))
    if (scenario === 'output') worker.mockRejectedValueOnce(new WorkerOutputLimitError())
    await drainLocalValidation(cwd)
    expect(worker).toHaveBeenCalledTimes(1)
    expect(latestEvidence()?.status).toBe('failed')
  })
  it('retries an explicit request after failure while daemon restarts do not reset the same SHA budget', async () => {
    const record = capture(stageTimeout)
    const worker = vi.spyOn(processWorker, 'runWorkerProcess')
    await drainLocalValidation(cwd)
    expect(worker).toHaveBeenCalledTimes(2)
    defaultCheckpointDeps(cwd).appendQueue({ ...record, validationStatus: 'running' })
    await drainLocalValidation(cwd)
    expect(worker).toHaveBeenCalledTimes(2)
    requestCheckpointValidation(cwd, record)
    await drainLocalValidation(cwd)
    expect(worker).toHaveBeenCalledTimes(4)
  })
  it('counts launches across interrupted daemon runs and requires explicit request after exhaustion', async () => {
    const record = capture()
    const worker = vi.spyOn(processWorker, 'runWorkerProcess').mockRejectedValue(new WorkerAbortedError())
    const first = new AbortController()
    worker.mockImplementationOnce(async () => { first.abort(); throw new WorkerAbortedError() })
    await drainLocalValidation(cwd, first.signal)
    expect(readJson(stateFiles()[0]!)).toMatchObject({ attempts: 1, status: 'running' })
    const state = readJson(stateFiles()[0]!) as object
    writeJson(stateFiles()[0]!, { ...state, nextAttemptAt: 0 })
    const second = new AbortController()
    worker.mockImplementationOnce(async () => { second.abort(); throw new WorkerAbortedError() })
    await drainLocalValidation(cwd, second.signal)
    await drainLocalValidation(cwd)
    expect(worker).toHaveBeenCalledTimes(2)
    expect(latestEvidence()).toMatchObject({ status: 'failed', failureReason: 'interrupted' })
    expect(readJson(stateFiles()[0]!)).toMatchObject({ attempts: 2, status: 'exhausted' })
    requestCheckpointValidation(cwd, record)
    worker.mockImplementation((bin, args, options) => realRunWorker(bin, args, options))
    await drainLocalValidation(cwd)
    expect(latestEvidence()?.status).toBe('passed')
    expect(worker).toHaveBeenCalledTimes(3)
  })
  it('cancels backoff immediately and does not consume another launch', async () => {
    capture(stageTimeout)
    const controller = new AbortController()
    const worker = vi.spyOn(processWorker, 'runWorkerProcess').mockImplementation(async (bin, args, options) => {
      try { return await realRunWorker(bin, args, options) }
      finally { setTimeout(() => controller.abort(), 30) }
    })
    await drainLocalValidation(cwd, controller.signal)
    expect(worker).toHaveBeenCalledTimes(1)
    expect(readJson(stateFiles()[0]!)).toMatchObject({ attempts: 1, status: 'waiting' })
    expect(defaultCheckpointDeps(cwd).readQueue().at(-1)?.validationStatus).toBe('pending')
  })
  it('does not erase a new explicit request submitted while an older validation finishes', async () => {
    const record = capture()
    requestCheckpointValidation(cwd, record)
    vi.spyOn(processWorker, 'runWorkerProcess').mockImplementationOnce(async (bin, args, options) => {
      const result = await realRunWorker(bin, args, options)
      requestCheckpointValidation(cwd, record)
      return result
    })
    await drainLocalValidation(cwd)
    expect(defaultCheckpointDeps(cwd).readQueue().at(-1)?.validationStatus).toBe('pending')
    expect(readJson(path.join(cwd, '.supremo/validation/requests', `${record.checkpointId}.json`))).not.toBeNull()
    await drainLocalValidation(cwd)
    expect(latestEvidence()?.status).toBe('passed')
    expect(readJson(path.join(cwd, '.supremo/validation/requests', `${record.checkpointId}.json`))).toBeNull()
  })
  it.each(['malformed', 'wrong-identity'] as const)('does not reset %s persisted retry accounting or loop after a restart', async scenario => {
    const record = capture("save('verify-result.json',{sha,base,status:'failed',checks:[{name:'unit',type:'unit',status:'failed'}]}); process.exit(1);")
    const worker = vi.spyOn(processWorker, 'runWorkerProcess')
    await drainLocalValidation(cwd)
    const file = stateFiles()[0]!
    if (scenario === 'malformed') fs.writeFileSync(file, '{bad')
    else {
      const state = readJson(file) as { evidence: LocalEvidence }
      writeJson(file, { ...state, evidence: { ...state.evidence, projectId: '22222222-2222-4222-8222-222222222222' } })
    }
    defaultCheckpointDeps(cwd).appendQueue({ ...record, validationStatus: 'running' })
    await drainLocalValidation(cwd)
    expect(worker).toHaveBeenCalledTimes(1)
    expect(latestEvidence()).toMatchObject({ status: 'failed', failureReason: 'invalid_evidence' })
    expect(await drainLocalValidation(cwd)).toBe(0)
  })
})
