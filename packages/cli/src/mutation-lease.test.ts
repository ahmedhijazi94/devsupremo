import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { reconcileAbandonedHost } from './host-recovery'
import { processIsGone, recordMutationLease, reconcileMutationLease } from './mutation-lease'
import { readJson, TURN_DIR, writeJson } from './turn-workspace'

let cwd: string
const identity = { hostPid: 987654, sessionId: 'session', turnId: 'turn' }
const lease = { version: 2, toolUseId: 'edit', ...identity, hostGroupId: 987650, executionScope: 'host-file-operation' }
const leaseFile = () => path.join(cwd, TURN_DIR, 'mutation-lease.json')
beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'supremo-lease-recovery-'))
  writeJson(path.join(cwd, TURN_DIR, 'state.json'), { ...identity, turn: { turnId: identity.turnId, status: 'active' } })
})
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(cwd, { force: true, recursive: true }) })
const dead = () => vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }) })

it('recovers a matching file operation only after both host and process group are proved dead', async () => {
  writeJson(leaseFile(), lease); const probe = dead()
  expect(await reconcileAbandonedHost(cwd)).toBe(true)
  expect(readJson(leaseFile())).toBeNull()
  expect(probe).toHaveBeenCalledWith(-lease.hostGroupId, 0)
  expect(readJson(path.join(cwd, TURN_DIR, 'state.json'))).toMatchObject({ turn: { status: 'blocked' } })
})
it.each(['live-host', 'live-group', 'permission'] as const)('preserves the reservation with %s evidence', async scenario => {
  writeJson(leaseFile(), lease)
  vi.spyOn(process, 'kill').mockImplementation(pid => {
    if (scenario === 'permission') throw Object.assign(new Error('unknown'), { code: 'EPERM' })
    if (scenario === 'live-host' || pid < 0) return true
    throw Object.assign(new Error('gone'), { code: 'ESRCH' })
  })
  expect(await reconcileAbandonedHost(cwd)).toBe(false)
  expect(readJson(leaseFile())).toEqual(lease)
})
it.each([
  { toolUseId: 'legacy' }, { ...lease, executionScope: 'untracked-process' },
  { ...lease, sessionId: 'other' }, { ...lease, turnId: 'other' }, { ...lease, hostPid: 999999 },
  { ...lease, hostGroupId: null },
])('never takes an ambiguous or differently bound reservation', async value => {
  writeJson(leaseFile(), value); dead()
  expect(await reconcileAbandonedHost(cwd)).toBe(false)
  expect(readJson(leaseFile())).toEqual(value)
})
it('classifies commands as untracked instead of assuming detached children died with their host', () => {
  recordMutationLease(cwd, { ...identity, hostPid: process.pid }, 'shell', 'Bash')
  expect(readJson(leaseFile())).toMatchObject({ version: 2, executionScope: 'untracked-process', hostPid: process.pid })
})
it.runIf(process.platform !== 'win32')('recovers after real process-group death but preserves a surviving child', async () => {
  let parent: ChildProcess | undefined, childPid: number | undefined
  try {
    parent = spawn(process.execPath, ['-e', "const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(child.pid);setInterval(()=>{},1000)"], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] })
    const [data] = await once(parent.stdout!, 'data')
    childPid = Number(String(data).trim())
    const actual = { ...identity, hostPid: parent.pid! }
    recordMutationLease(cwd, actual, 'write', 'Write')
    expect(readJson(leaseFile())).toMatchObject({ hostGroupId: parent.pid, executionScope: 'host-file-operation' })
    const exited = once(parent, 'exit'); parent.kill('SIGTERM'); await exited
    expect(reconcileMutationLease(cwd, actual)).toBe(false)
    // The group remains reserved until the child has actually stopped.
    process.kill(childPid, 'SIGTERM')
    await vi.waitFor(() => expect(reconcileMutationLease(cwd, actual)).toBe(true), { timeout: 3000, interval: 25 })
    expect(readJson(leaseFile())).toBeNull()
  } finally {
    if (parent?.pid) { try { process.kill(-parent.pid, 'SIGKILL') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error } }
  }
}, 8000)

it.runIf(process.platform !== 'win32')('preserves a shell lease when a detached child survives outside the dead host group', async () => {
  let parent: ChildProcess | undefined, childPid: number | undefined
  try {
    parent = spawn(process.execPath, ['-e', "const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});child.unref();console.log(child.pid);setInterval(()=>{},1000)"], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] })
    const [data] = await once(parent.stdout!, 'data')
    childPid = Number(String(data).trim())
    const actual = { ...identity, hostPid: parent.pid! }
    recordMutationLease(cwd, actual, 'shell', 'Bash')
    const before = readJson(leaseFile())
    const exited = once(parent, 'exit'); parent.kill('SIGTERM'); await exited
    expect(processIsGone(actual.hostPid)).toBe(true)
    expect(processIsGone(-actual.hostPid)).toBe(true)
    expect(processIsGone(childPid)).toBe(false)
    expect(reconcileMutationLease(cwd, actual)).toBe(false)
    expect(readJson(leaseFile())).toEqual(before)
  } finally {
    for (const pid of [childPid, parent?.pid]) {
      if (pid) { try { process.kill(pid, 'SIGKILL') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error } }
    }
  }
}, 8000)
