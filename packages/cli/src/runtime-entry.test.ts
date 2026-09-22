import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { spawn, type ChildProcess } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readProjectStack } from './framework-runtime'
import { lookupProjectRuntime, type ProjectRuntime } from './project-runtime'
import { maybeRelaunchWithProjectRuntime, runPreviewWithProjectRuntime } from './runtime-entry'

vi.mock('node:child_process', () => ({ spawn: vi.fn() }))
vi.mock('./framework-runtime', () => ({ readProjectStack: vi.fn(), assertFrameworkNodeVersion: (stack: string | null, version: string): void => {
  const major = Number(version.replace(/^v/, '').split('.')[0])
  if (stack === 'tanstack-start-vite' && major === 23) throw new Error('Unsupported fixture version')
} }))
vi.mock('./project-runtime', async importOriginal => ({ ...await importOriginal<typeof import('./project-runtime')>(), lookupProjectRuntime: vi.fn() }))

let cwd: string
let runtime: ProjectRuntime
let child: EventEmitter & { kill: ReturnType<typeof vi.fn> }
let priorExitCode: string | number | undefined
let priorVersion: PropertyDescriptor
const launch = vi.mocked(spawn)
const discover = vi.mocked(lookupProjectRuntime)
const stack = vi.mocked(readProjectStack)
const cliArgs = (): string[] => [process.execPath, path.join(cwd, 'cli.js'), 'turn', 'start', '--host', 'codex']

beforeEach(() => {
  cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'supremo-runtime-entry-')))
  fs.mkdirSync(path.join(cwd, 'scripts'))
  fs.writeFileSync(path.join(cwd, 'scripts/preview.mjs'), '// fixture supervisor')
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ dependencies: { '@tanstack/react-start': '1.168.4' } }))
  const binary = path.join(cwd, 'node')
  fs.writeFileSync(binary, 'fixture executable')
  runtime = { node: binary, npm: '/fixture/npm-cli.js', env: { PATH: '/fixture/runtime:/usr/bin' }, version: 'v22.22.1', source: 'project' }
  child = Object.assign(new EventEmitter(), { kill: vi.fn(() => true) })
  priorExitCode = process.exitCode
  priorVersion = Object.getOwnPropertyDescriptor(process, 'version')!
  Object.defineProperty(process, 'version', { ...priorVersion, value: 'v23.11.0' })
  launch.mockReset().mockImplementation(() => child as unknown as ChildProcess)
  discover.mockReset().mockResolvedValue(runtime)
  stack.mockReset().mockReturnValue('tanstack-start-vite')
})
afterEach(() => {
  child.emit('close', 0, null)
  process.exitCode = priorExitCode
  Object.defineProperty(process, 'version', priorVersion)
  vi.restoreAllMocks()
  fs.rmSync(cwd, { recursive: true, force: true })
})

async function launched(): Promise<void> { await Promise.resolve(); await Promise.resolve() }

describe('read-only CLI runtime boundary', () => {
  it('leaves an incomplete legacy Next fixture to its original command without validating its stack', async () => {
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ name: 'legacy-fixture' }))
    fs.mkdirSync(path.join(cwd, '.supremo'))
    fs.writeFileSync(path.join(cwd, '.supremo/project.json'), JSON.stringify({ stack: 'nextjs', scaffoldVersion: '4.0.9' }))
    stack.mockImplementation(() => { throw new Error('A stack declarada não corresponde às dependências') })
    for (const command of ['daemon', 'checkpoint']) {
      expect(await maybeRelaunchWithProjectRuntime(cwd, [process.execPath, '/cli.js', command])).toBe(false)
    }
    expect(stack).not.toHaveBeenCalled()
    expect(discover).not.toHaveBeenCalled()
    expect(launch).not.toHaveBeenCalled()
  })

  it('ignores malformed and missing manifests during discovery of unrelated projects', async () => {
    fs.writeFileSync(path.join(cwd, 'package.json'), '{malformed')
    expect(await maybeRelaunchWithProjectRuntime(cwd, cliArgs())).toBe(false)
    fs.unlinkSync(path.join(cwd, 'package.json'))
    expect(await maybeRelaunchWithProjectRuntime(cwd, cliArgs())).toBe(false)
    expect(stack).not.toHaveBeenCalled()
    expect(discover).not.toHaveBeenCalled()
  })

  it('returns before project validation when the current process already has compatible Node', async () => {
    Object.defineProperty(process, 'version', { ...priorVersion, value: 'v24.1.0' })
    stack.mockImplementation(() => { throw new Error('Should not inspect the stack') })
    expect(await maybeRelaunchWithProjectRuntime(cwd, cliArgs())).toBe(false)
    expect(stack).not.toHaveBeenCalled()
    expect(discover).not.toHaveBeenCalled()
    expect(launch).not.toHaveBeenCalled()
  })

  it('relaunches the same command under the prepared Node, with inherited I/O and unchanged global env', async () => {
    const original = { ...process.env }
    const result = maybeRelaunchWithProjectRuntime(cwd, cliArgs())
    await launched()
    expect(discover).toHaveBeenCalledExactlyOnceWith(cwd, 'tanstack-start-vite')
    expect(launch).toHaveBeenCalledExactlyOnceWith(runtime.node, cliArgs().slice(1), { cwd, env: runtime.env, stdio: 'inherit' })
    child.emit('close', 7, null)
    await expect(result).resolves.toBe(true)
    expect(process.exitCode).toBe(7)
    expect(process.env).toEqual(original)
  })

  it.each(['bootstrap', 'prepare', '--help', '--version', 'unknown'])('does not probe or launch for %s', async command => {
    expect(await maybeRelaunchWithProjectRuntime(cwd, [process.execPath, '/cli.js', command])).toBe(false)
    expect(stack).not.toHaveBeenCalled()
    expect(discover).not.toHaveBeenCalled()
    expect(launch).not.toHaveBeenCalled()
  })

  it('does not probe for command help or a non-Start checkout', async () => {
    expect(await maybeRelaunchWithProjectRuntime(cwd, [...cliArgs(), '--help'])).toBe(false)
    stack.mockReturnValue('nextjs')
    expect(await maybeRelaunchWithProjectRuntime(cwd, cliArgs())).toBe(false)
    expect(discover).not.toHaveBeenCalled()
  })

  it('does not install or relaunch when lookup finds no prepared runtime', async () => {
    discover.mockResolvedValue(null)
    expect(await maybeRelaunchWithProjectRuntime(cwd, cliArgs())).toBe(false)
    expect(launch).not.toHaveBeenCalled()
  })

  it('prevents a loop for a compatible current Node, the same executable or an incompatible result', async () => {
    discover.mockResolvedValue({ ...runtime, source: 'current' })
    expect(await maybeRelaunchWithProjectRuntime(cwd, cliArgs())).toBe(false)
    discover.mockResolvedValue({ ...runtime, node: process.execPath })
    expect(await maybeRelaunchWithProjectRuntime(cwd, cliArgs())).toBe(false)
    discover.mockResolvedValue({ ...runtime, version: 'v23.11.0' })
    expect(await maybeRelaunchWithProjectRuntime(cwd, cliArgs())).toBe(false)
    expect(launch).not.toHaveBeenCalled()
  })

  it('forwards interruption, removes handlers on close and propagates the terminal signal', async () => {
    const on = vi.spyOn(process, 'on')
    const terminate = vi.spyOn(process, 'kill').mockReturnValue(true)
    const result = maybeRelaunchWithProjectRuntime(cwd, cliArgs())
    await launched()
    const handler = on.mock.calls.find(call => call[0] === 'SIGTERM')?.[1]
    expect(handler).toBeDefined()
    handler?.()
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    child.emit('close', null, 'SIGTERM')
    await expect(result).resolves.toBe(true)
    expect(terminate).toHaveBeenCalledWith(process.pid, 'SIGTERM')
    expect(process.listeners('SIGTERM')).not.toContain(handler)
    expect(process.exitCode).toBe(143)
  })

  it('sanitizes spawn failures and removes forwarding handlers', async () => {
    const before = process.listenerCount('SIGTERM')
    const result = maybeRelaunchWithProjectRuntime(cwd, cliArgs())
    await launched()
    child.emit('error', new Error('private-credential in child error'))
    await expect(result).rejects.toThrow(/supremo prepare/)
    expect(process.listenerCount('SIGTERM')).toBe(before)
  })
})

describe('preview wrapper runtime selection', () => {
  it.each(['ensure', 'status', 'stop'])('launches only the local supervisor for %s', async action => {
    const result = runPreviewWithProjectRuntime(cwd, [action])
    await launched()
    expect(launch).toHaveBeenCalledExactlyOnceWith(runtime.node, [path.join(cwd, 'scripts/preview.mjs'), action], { cwd, env: runtime.env, stdio: 'inherit' })
    child.emit('close', 0, null)
    await expect(result).resolves.toBeUndefined()
  })

  it('rejects custom scripts and extra arguments before discovery', async () => {
    for (const args of [['../custom.mjs'], ['ensure', '--eval', 'evil'], ['__heartbeat']]) {
      await expect(runPreviewWithProjectRuntime(cwd, args)).rejects.toThrow(/ensure, status ou stop/)
    }
    expect(discover).not.toHaveBeenCalled()
    expect(launch).not.toHaveBeenCalled()
  })

  it('reports missing preparation without installing or starting the preview', async () => {
    discover.mockResolvedValue(null)
    await expect(runPreviewWithProjectRuntime(cwd, ['ensure'])).rejects.toThrow(/supremo prepare/)
    expect(launch).not.toHaveBeenCalled()
  })

  it('rejects a supervisor symlink before execution', async () => {
    const script = path.join(cwd, 'scripts/preview.mjs')
    fs.unlinkSync(script)
    fs.symlinkSync(runtime.node, script)
    await expect(runPreviewWithProjectRuntime(cwd, ['status'])).rejects.toThrow()
    expect(launch).not.toHaveBeenCalled()
  })
})
