import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DAEMON_PID_FILE, DAEMON_PROGRESS_FILE, ensureDaemon, stopDaemon } from './daemon'
import { inspectManagedDaemon, processState, stopManagedDaemon, withDaemonControl, type ManagedDaemonIdentity, type StopDaemonDependencies } from './daemon-lifecycle'

const directories: string[] = []
const pids: number[] = []
const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
function workspace(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'supremo-daemon-lifecycle-'))
  directories.push(cwd)
  fs.mkdirSync(path.join(cwd, 'node_modules/.bin'), { recursive: true })
  fs.mkdirSync(path.join(cwd, '.supremo/checkpoints'), { recursive: true })
  fs.writeFileSync(path.join(cwd, 'node_modules/.bin/supremo'), "require('node:fs').writeFileSync('ready-'+process.pid,'yes');setInterval(()=>{},1000)")
  return cwd
}
function pid(cwd: string): number { return Number(fs.readFileSync(path.join(cwd, DAEMON_PID_FILE), 'utf8')) }
async function ready(cwd: string, target: number): Promise<void> {
  for (let i = 0; i < 100; i++) { if (fs.existsSync(path.join(cwd, `ready-${target}`))) return; await pause(30) }
  throw new Error('Fixture daemon did not start')
}
function stale(cwd: string, target: number): void {
  const now = Date.now()
  fs.writeFileSync(path.join(cwd, DAEMON_PROGRESS_FILE), JSON.stringify({ pid: target, phase: 'checking', updatedAt: new Date(now).toISOString(), deadlineAt: new Date(now + 1).toISOString(), recoveredTimeouts: 0 }))
  vi.spyOn(Date, 'now').mockReturnValue(now + 60_000)
}
afterEach(async () => {
  vi.restoreAllMocks()
  for (const target of pids.splice(0)) { try { process.kill(target, 'SIGKILL') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error } }
  await pause(20)
  for (const cwd of directories.splice(0)) fs.rmSync(cwd, { recursive: true, force: true })
})

const identity: ManagedDaemonIdentity = { command: 'node /project/bin daemon', cwd: '/project', started: 'start-one', startedAt: 1 }
function dependencies(): StopDaemonDependencies {
  return { inspect: async () => identity, current: () => true, state: () => 'alive', signal: vi.fn(), pause: async () => {} }
}
describe('bounded daemon termination', () => {
  it('never signals an unknown/EPERM process', async () => {
    const deps = dependencies(); deps.state = () => 'unknown'
    expect(await stopManagedDaemon(identity, deps)).toBe(false)
    expect(deps.signal).not.toHaveBeenCalled()
  })
  it('checks PID identity and ownership again before SIGKILL', async () => {
    const deps = dependencies(); let checks = 0
    deps.inspect = async () => ++checks === 1 ? identity : { ...identity, started: 'different-process' }
    expect(await stopManagedDaemon(identity, deps)).toBe(false)
    expect(deps.signal).toHaveBeenCalledExactlyOnceWith('SIGTERM')
  })
  it('never claims success until process disappearance is confirmed', async () => {
    const deps = dependencies()
    expect(await stopManagedDaemon(identity, deps)).toBe(false)
    expect(deps.signal).toHaveBeenNthCalledWith(1, 'SIGTERM')
    expect(deps.signal).toHaveBeenNthCalledWith(2, 'SIGKILL')
  })
  it('does not kill a process whose workspace pidfile was replaced', async () => {
    const deps = dependencies(); deps.current = () => false
    expect(await stopManagedDaemon(identity, deps)).toBe(false)
    expect(deps.signal).not.toHaveBeenCalled()
  })
  it('rechecks ownership after asynchronous OS inspection', async () => {
    const deps = dependencies(); let current = true
    deps.current = () => current
    deps.inspect = async () => { current = false; return identity }
    expect(await stopManagedDaemon(identity, deps)).toBe(false)
    expect(deps.signal).not.toHaveBeenCalled()
  })
  it('does not continue after signal permission is denied', async () => {
    const deps = dependencies(); deps.signal = vi.fn(() => { throw Object.assign(new Error('denied'), { code: 'EPERM' }) })
    expect(await stopManagedDaemon(identity, deps)).toBe(false)
    expect(deps.signal).toHaveBeenCalledTimes(1)
  })
  it('returns success after TERM and ESRCH without a SIGKILL', async () => {
    const deps = dependencies(); let dead = false
    deps.signal = vi.fn(() => { dead = true }); deps.state = () => dead ? 'dead' : 'alive'
    expect(await stopManagedDaemon(identity, deps)).toBe(true)
    expect(deps.signal).toHaveBeenCalledExactlyOnceWith('SIGTERM')
  })
})

describe('daemon lifecycle with real managed processes', () => {
  it('serializes simultaneous starts and preserves preview/env while recovering stale upload', async () => {
    const cwd = workspace()
    fs.writeFileSync(path.join(cwd, '.env.local'), 'KEEP_THIS_PRIVATE=unchanged')
    fs.writeFileSync(path.join(cwd, 'preview.pid'), 'unchanged')
    expect((await Promise.all([ensureDaemon(cwd), ensureDaemon(cwd)])).sort()).toEqual(['reuse', 'start'])
    const old = pid(cwd); pids.push(old); await ready(cwd, old)
    expect(await inspectManagedDaemon(cwd, old, [path.join(cwd, 'node_modules/.bin/supremo')])).not.toBeNull()
    stale(cwd, old)
    expect(await ensureDaemon(cwd)).toBe('start')
    const replacement = pid(cwd); pids.push(replacement); await ready(cwd, replacement)
    expect(replacement).not.toBe(old)
    expect(processState(old)).toBe('dead')
    expect(fs.readFileSync(path.join(cwd, '.env.local'), 'utf8')).toBe('KEEP_THIS_PRIVATE=unchanged')
    expect(fs.readFileSync(path.join(cwd, 'preview.pid'), 'utf8')).toBe('unchanged')
    expect(await stopDaemon(cwd)).toBe(true)
    expect(processState(replacement)).toBe('dead')
  }, 15000)
  it('preserves malformed/mismatched progress and rejects an unrelated process even with stale progress', async () => {
    const cwd = workspace()
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd, stdio: 'ignore' })
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
    const target = child.pid!; pids.push(target)
    fs.writeFileSync(path.join(cwd, DAEMON_PID_FILE), String(target))
    fs.writeFileSync(path.join(cwd, DAEMON_PROGRESS_FILE), '{bad')
    expect(await ensureDaemon(cwd)).toBe('reuse')
    stale(cwd, target)
    expect(await ensureDaemon(cwd)).toBe('reuse')
    expect(await stopDaemon(cwd)).toBe(false)
    expect(pid(cwd)).toBe(target)
    expect(processState(target)).toBe('alive')
  })
  it('recovers abandoned ownership and an abandoned reclaim lease', async () => {
    const cwd = workspace()
    const dead = Number(execFileSync(process.execPath, ['-p', 'process.pid'], { encoding: 'utf8' }).trim())
    const lock = path.join(cwd, '.supremo/checkpoints/daemon-control.lock')
    fs.mkdirSync(lock)
    fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: dead, token: 'abandoned-owner' }))
    fs.mkdirSync(path.join(lock, 'reclaim'))
    fs.writeFileSync(path.join(lock, 'reclaim/owner.json'), JSON.stringify({ pid: dead, token: 'abandoned-reclaim' }))
    expect(await withDaemonControl(cwd, async () => 'recovered')).toBe('recovered')
    expect(fs.existsSync(lock)).toBe(false)
  })
  it('atomically publishes ownership even over an empty partial legacy lock', async () => {
    const cwd = workspace()
    const lock = path.join(cwd, '.supremo/checkpoints/daemon-control.lock')
    fs.mkdirSync(lock)
    await withDaemonControl(cwd, async () => {
      expect(JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8'))).toMatchObject({ pid: process.pid })
    })
    expect(fs.existsSync(lock)).toBe(false)
  })
  it.each([1, 2, 3, 4, 5])('serializes separate CLI processes recovering the same abandoned reclaim (%i)', async () => {
    const cwd = workspace()
    const dead = Number(execFileSync(process.execPath, ['-p', 'process.pid'], { encoding: 'utf8' }).trim())
    const lock = path.join(cwd, '.supremo/checkpoints/daemon-control.lock')
    fs.mkdirSync(path.join(lock, 'reclaim'), { recursive: true })
    for (const [directory, token] of [[lock, 'owner'], [path.join(lock, 'reclaim'), 'claim']]) {
      fs.writeFileSync(path.join(directory!, 'owner.json'), JSON.stringify({ pid: dead, token }))
    }
    const helper = path.resolve(import.meta.dirname, 'daemon-lifecycle.ts')
    const script = `const fs=require('node:fs'); const {withDaemonControl}=require(process.argv[1]);
      withDaemonControl(process.argv[2],async()=>{const target=process.argv[2]+'/exclusive';
      const fd=fs.openSync(target,'wx');await new Promise(r=>setTimeout(r,30));fs.closeSync(fd);fs.unlinkSync(target)
      }).catch(error=>{console.error(error);process.exitCode=1})`
    const codes = await Promise.all(Array.from({ length: 6 }, () => new Promise<{code: number | null; error: string}>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', '-e', script, helper, cwd], { stdio: ['ignore', 'ignore', 'pipe'] })
      if (child.pid) pids.push(child.pid)
      let error = ''; child.stderr?.on('data', data => { error += String(data) })
      child.once('error', reject); child.once('exit', code => resolve({ code, error }))
    })))
    expect(codes).toEqual(Array.from({ length: 6 }, () => ({ code: 0, error: '' })))
  }, 15000)
})
