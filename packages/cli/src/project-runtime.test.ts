import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { compatibleProjectNode, ensureProjectRuntime, lookupProjectRuntime, PROJECT_NODE_VERSION, projectNodePackage, projectRuntimeEnvironment, type ProjectRuntimeIO } from './project-runtime'

let fixture: string
let cwd: string
let currentNode: string
let npm: string
let io: ProjectRuntimeIO
let currentVersion: string
let installedVersion: string
const runner = vi.fn<ProjectRuntimeIO['run']>()
const runtimeDirectory = (): string => path.join(cwd, '.supremo/runtime/node-22.22.1-darwin-arm64')
const localBinary = (directory = runtimeDirectory()): string => path.join(directory, 'node_modules/node-bin-darwin-arm64/bin/node')
function writeBinary(directory = runtimeDirectory()): string {
  const binary = localBinary(directory)
  fs.mkdirSync(path.dirname(binary), { recursive: true })
  fs.writeFileSync(binary, 'fixture binary', { mode: 0o700 })
  return binary
}

beforeEach(() => {
  fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'supremo-project-runtime-')))
  cwd = path.join(fixture, 'project')
  fs.mkdirSync(cwd)
  currentNode = path.join(fixture, 'system/bin/node')
  npm = path.join(fixture, 'system/lib/node_modules/npm/bin/npm-cli.js')
  for (const file of [currentNode, npm]) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'fixture') }
  currentVersion = 'v23.11.0'
  installedVersion = `v${PROJECT_NODE_VERSION}`
  runner.mockReset()
  runner.mockImplementation(async (node, args, options) => {
    if (args[0] === '--version') return node === currentNode ? currentVersion : installedVersion
    writeBinary(options.cwd)
    return ''
  })
  io = { node: currentNode, platform: 'darwin', arch: 'arm64', env: { PATH: '/usr/bin:/bin', NODE_OPTIONS: '--inspect', NPM_TOKEN: 'private-token', SUPABASE_SERVICE_ROLE_KEY: 'private-database-key' }, run: runner }
})
afterEach(() => { fs.rmSync(fixture, { recursive: true, force: true }) })

describe('project runtime selection', () => {
  it('discovers a prepared runtime without installing or writing files', async () => {
    expect(await lookupProjectRuntime(cwd, 'tanstack-start-vite', io)).toBeNull()
    expect(fs.readdirSync(cwd)).toEqual([])
    const binary = writeBinary()
    expect(await lookupProjectRuntime(cwd, 'tanstack-start-vite', io)).toMatchObject({ source: 'project', node: binary })
    expect(runner.mock.calls.every(call => call[1][0] === '--version')).toBe(true)
  })

  it('leaves an existing runtime directory untouched when discovery finds no prepared version', async () => {
    fs.mkdirSync(path.join(cwd, '.supremo/runtime'), { recursive: true })
    expect(await lookupProjectRuntime(cwd, 'tanstack-start-vite', io)).toBeNull()
    expect(fs.readdirSync(path.join(cwd, '.supremo/runtime'))).toEqual([])
  })

  it('probes the actual executable and reuses a supported runtime without writing project files', async () => {
    currentVersion = 'v24.1.0'
    const original = { ...io.env }
    const result = await ensureProjectRuntime(cwd, 'tanstack-start-vite', io)
    expect(result).toMatchObject({ node: currentNode, npm, version: currentVersion, source: 'current' })
    expect(result.env.PATH).toBe(`${path.dirname(currentNode)}:/usr/bin:/bin`)
    expect(result.env.npm_node_execpath).toBe(currentNode)
    expect(result.env.npm_execpath).toBe(npm)
    expect(io.env).toEqual(original)
    expect(runner).toHaveBeenCalledExactlyOnceWith(currentNode, ['--version'], expect.objectContaining({ cwd: fs.realpathSync(cwd), timeout: 10_000, env: expect.not.objectContaining({ NODE_OPTIONS: expect.anything() }) }))
    expect(fs.readdirSync(cwd)).toEqual([])
  })

  it('preserves the existing behavior of legacy and unidentified projects', async () => {
    currentVersion = 'v18.20.0'
    for (const stack of ['nextjs', null] as const) expect((await ensureProjectRuntime(cwd, stack, io)).source).toBe('current')
    expect(fs.readdirSync(cwd)).toEqual([])
  })

  it('reuses the exact local runtime after verifying its real version', async () => {
    const binary = writeBinary()
    const result = await ensureProjectRuntime(cwd, 'tanstack-start-vite', io)
    expect(result).toMatchObject({ source: 'project', node: fs.realpathSync(binary), version: installedVersion })
    expect(runner.mock.calls.map(call => call[1])).toEqual([['--version'], ['--version']])
  })

  it('preserves and rejects a cached runtime with an unexpected actual version', async () => {
    const binary = writeBinary()
    installedVersion = 'v24.1.0'
    await expect(ensureProjectRuntime(cwd, 'tanstack-start-vite', io)).rejects.toThrow(/não corresponde/)
    expect(fs.readFileSync(binary, 'utf8')).toBe('fixture binary')
    expect(runner).toHaveBeenCalledTimes(2)
  })

  it('never accepts metadata or malformed executable output as a version', async () => {
    currentVersion = 'v24.1.0\nprivate-output'
    await expect(ensureProjectRuntime(cwd, 'tanstack-start-vite', io)).rejects.toThrow(/versão válida/)
    expect(fs.readdirSync(cwd)).toEqual([])
  })
})

describe('scoped runtime preparation', () => {
  it('installs the exact official binary package with isolated configuration and bounded execution', async () => {
    const environmentBefore = { ...process.env }
    const result = await ensureProjectRuntime(cwd, 'tanstack-start-vite', io)
    const install = runner.mock.calls.find(call => call[1][1] === 'install')!
    const [executable, args, options] = install
    expect(executable).toBe(currentNode)
    expect(args).toEqual([npm, 'install', 'node-bin-darwin-arm64@22.22.1',
      '--prefix', options.cwd, '--registry', 'https://registry.npmjs.org/', '--userconfig', path.join(options.cwd, '.npmrc'),
      '--globalconfig', path.join(options.cwd, 'global.npmrc'), '--cache', path.join(options.cwd, 'cache'),
      '--ignore-scripts', '--no-bin-links', '--no-audit', '--no-fund', '--package-lock=false', '--save=false',
      '--fetch-retries=1', '--fetch-timeout=30000', '--loglevel=error'])
    expect(options.timeout).toBe(120_000)
    expect(options.cwd.startsWith(path.join(fs.realpathSync(cwd), '.supremo/runtime/.install-'))).toBe(true)
    expect(options.env).not.toHaveProperty('NPM_TOKEN')
    expect(options.env).not.toHaveProperty('SUPABASE_SERVICE_ROLE_KEY')
    expect(options.env).not.toHaveProperty('NODE_OPTIONS')
    for (const key of ['HOME', 'USERPROFILE', 'TMPDIR', 'TMP', 'TEMP']) expect(options.env[key]?.startsWith(options.cwd)).toBe(true)
    expect(result).toMatchObject({ node: fs.realpathSync(localBinary()), source: 'installed', version: installedVersion })
    expect(runner.mock.calls.at(-1)?.[1]).toEqual(['--version'])
    expect(fs.existsSync(options.cwd)).toBe(false)
    expect(process.env).toEqual(environmentBefore)
    expect(fs.readdirSync(cwd)).toEqual(['.supremo'])
    expect(fs.existsSync(path.join(cwd, '.npmrc'))).toBe(false)
    expect(fs.existsSync(path.join(cwd, 'package.json'))).toBe(false)
  })

  it('does not publish a package whose binary reports the wrong version', async () => {
    installedVersion = 'v23.11.0'
    await expect(ensureProjectRuntime(cwd, 'tanstack-start-vite', io)).rejects.toThrow(/Não foi possível preparar/)
    expect(fs.readdirSync(path.join(cwd, '.supremo/runtime'))).toEqual([])
  })

  it('cleans failed installs without exposing process output or ambient credentials', async () => {
    runner.mockImplementation(async (_node, args) => {
      if (args[0] === '--version') return currentVersion
      throw new Error('private-token and private-database-key from subprocess')
    })
    let message = ''
    try { await ensureProjectRuntime(cwd, 'tanstack-start-vite', io) }
    catch (error) { message = (error as Error).message }
    expect(message).toMatch(/Verifique a conexão/)
    expect(message).not.toMatch(/private-/)
    expect(fs.readdirSync(path.join(cwd, '.supremo/runtime'))).toEqual([])
  })

  it('preserves a destination created by a simultaneous preparation', async () => {
    runner.mockImplementation(async (node, args, options) => {
      if (args[0] === '--version') return node === currentNode ? currentVersion : installedVersion
      writeBinary(options.cwd)
      writeBinary()
      return ''
    })
    await expect(ensureProjectRuntime(cwd, 'tanstack-start-vite', io)).rejects.toThrow(/Não foi possível preparar/)
    expect(fs.readFileSync(localBinary(), 'utf8')).toBe('fixture binary')
    expect(fs.readdirSync(path.join(cwd, '.supremo/runtime'))).toEqual([path.basename(runtimeDirectory())])
  })
})

describe('project runtime filesystem boundaries', () => {
  it.each(['.supremo', '.supremo/runtime', '.supremo/runtime/node-22.22.1-darwin-arm64'])('refuses a symlink at %s without writing through it', async relative => {
    const external = path.join(fixture, 'external')
    fs.mkdirSync(external)
    const target = path.join(cwd, relative)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.symlinkSync(external, target)
    await expect(ensureProjectRuntime(cwd, 'tanstack-start-vite', io)).rejects.toThrow(/link simbólico/)
    expect(fs.readdirSync(external)).toEqual([])
    expect(runner).toHaveBeenCalledTimes(1)
  })

  it('refuses a symlinked project root', async () => {
    const alias = path.join(fixture, 'alias')
    fs.symlinkSync(cwd, alias)
    await expect(ensureProjectRuntime(alias, 'tanstack-start-vite', io)).rejects.toThrow(/diretório real/)
    expect(runner).not.toHaveBeenCalled()
  })

  it('refuses a cached executable link before launching it', async () => {
    const binary = writeBinary()
    fs.unlinkSync(binary)
    fs.symlinkSync(currentNode, binary)
    await expect(ensureProjectRuntime(cwd, 'tanstack-start-vite', io)).rejects.toThrow(/link simbólico/)
    expect(runner).toHaveBeenCalledTimes(1)
  })

  it('rejects an installed binary linked outside the project and leaves its target unchanged', async () => {
    runner.mockImplementation(async (_node, args, options) => {
      if (args[0] === '--version') return currentVersion
      const binary = writeBinary(options.cwd)
      fs.unlinkSync(binary)
      fs.symlinkSync(currentNode, binary)
      return ''
    })
    await expect(ensureProjectRuntime(cwd, 'tanstack-start-vite', io)).rejects.toThrow(/Não foi possível preparar/)
    expect(fs.readFileSync(currentNode, 'utf8')).toBe('fixture')
    expect(runner).toHaveBeenCalledTimes(2)
    expect(fs.readdirSync(path.join(cwd, '.supremo/runtime'))).toEqual([])
  })
})

describe('runtime policy helpers', () => {
  it('enforces the supported stable Start release lines', () => {
    for (const version of ['18.20.0', '20.19.0', '22.12.9', '23.11.0', 'v24.0.0-rc.1', 'invalid']) expect(compatibleProjectNode('tanstack-start-vite', version)).toBe(false)
    for (const version of ['22.13.0', 'v22.22.1', 'v24.0.0', '25.0.0']) expect(compatibleProjectNode('tanstack-start-vite', version)).toBe(true)
  })

  it('uses an explicit package mapping and refuses unsupported systems', () => {
    expect(projectNodePackage('darwin', 'arm64')).toBe('node-bin-darwin-arm64')
    expect(projectNodePackage('darwin', 'x64')).toBe('node-darwin-x64')
    expect(projectNodePackage('linux', 'x64')).toBe('node-linux-x64')
    expect(projectNodePackage('linux', 'arm64')).toBe('node-linux-arm64')
    expect(projectNodePackage('win32', 'x64')).toBe('node-win-x64')
    expect(() => projectNodePackage('linux', '../outside')).toThrow(/arquitetura/)
    expect(() => projectNodePackage('freebsd', 'x64')).toThrow(/sistema/)
  })

  it('preserves Windows PATH casing and returns an independent environment', () => {
    const env = { Path: 'C:\\Windows', OTHER: 'unchanged' }
    const result = projectRuntimeEnvironment('C:\\project\\bin\\node.exe', 'C:\\npm\\npm-cli.js', env, 'win32')
    expect(result.Path).toBe('C:\\project\\bin;C:\\Windows')
    expect(result.PATH).toBeUndefined()
    expect(env).toEqual({ Path: 'C:\\Windows', OTHER: 'unchanged' })
  })

  it('resolves npm from its real launcher when paired npm is unavailable', async () => {
    const alternate = path.join(fixture, 'alternate/npm-cli.js')
    fs.mkdirSync(path.dirname(alternate))
    fs.renameSync(npm, alternate)
    io.env.npm_execpath = alternate
    currentVersion = 'v24.1.0'
    expect((await ensureProjectRuntime(cwd, 'tanstack-start-vite', io)).npm).toBe(alternate)
  })

  it('fails without installing if npm is absent', async () => {
    fs.unlinkSync(npm)
    io.env.PATH = path.join(fixture, 'missing-bin')
    await expect(ensureProjectRuntime(cwd, 'tanstack-start-vite', io)).rejects.toThrow(/gerenciador de dependências/)
    expect(runner).not.toHaveBeenCalled()
    expect(fs.readdirSync(cwd)).toEqual([])
  })
})
