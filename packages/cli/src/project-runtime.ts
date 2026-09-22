import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { assertFrameworkNodeVersion } from './framework-runtime'
import type { ProjectStack } from './project-stack'

export const PROJECT_NODE_VERSION = '22.22.1'
const REGISTRY = 'https://registry.npmjs.org/'

export interface ProjectRuntime {
  node: string
  /** Invoke with node: [runtime.npm, ...npmArgs], never through a shell. */
  npm: string
  env: NodeJS.ProcessEnv
  version: string
  source: 'current' | 'project' | 'installed'
}

interface RuntimeCommandOptions {
  cwd: string
  env: NodeJS.ProcessEnv
  timeout: number
}

export interface ProjectRuntimeIO {
  node: string
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  arch: string
  run: (executable: string, args: string[], options: RuntimeCommandOptions) => Promise<string>
}

function run(executable: string, args: string[], options: RuntimeCommandOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(executable, args, { ...options, encoding: 'utf8', maxBuffer: 128 * 1024, killSignal: 'SIGKILL', windowsHide: true }, (error, stdout) => {
      // Child stderr can contain local configuration or credentials. Never return it.
      if (error) reject(new Error(error.killed ? 'A preparação excedeu o tempo limite.' : 'O processo de preparação não foi concluído.'))
      else resolve(stdout)
    })
  })
}

export function compatibleProjectNode(stack: ProjectStack | null, version: string): boolean {
  if (!/^v?\d+\.\d+\.\d+$/.test(version)) return false
  try { assertFrameworkNodeVersion(stack, version); return true }
  catch { return false }
}

/** These are the binary packages used by the npm node distribution itself.
 * Installing the exact binary with scripts disabled avoids the metapackage's
 * install hook and its floating node-bin-setup dependency. */
export function projectNodePackage(platform: NodeJS.Platform, arch: string): string {
  if (arch !== 'arm64' && arch !== 'x64') throw new Error('Preparação automática indisponível para esta arquitetura.')
  if (platform === 'darwin') return arch === 'arm64' ? 'node-bin-darwin-arm64' : 'node-darwin-x64'
  if (platform === 'linux') return `node-linux-${arch}`
  if (platform === 'win32') return `node-win-${arch}`
  throw new Error('Preparação automática indisponível para este sistema operacional.')
}

export function projectRuntimeEnvironment(node: string, npm: string, source: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const result = { ...source }
  const key = platform === 'win32' ? Object.keys(result).find(name => name.toLowerCase() === 'path') ?? 'PATH' : 'PATH'
  const paths = platform === 'win32' ? path.win32 : path
  const separator = platform === 'win32' ? ';' : path.delimiter
  result[key] = [paths.dirname(node), result[key]].filter(Boolean).join(separator)
  result.npm_node_execpath = node
  result.npm_execpath = npm
  return result
}

function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'ENOENT' }
function optionalStat(file: string): fs.Stats | null {
  try { return fs.lstatSync(file) }
  catch (error) { if (missing(error)) return null; throw error }
}

/** Never follow a project-owned link, including any intermediate directory. */
function assertScoped(root: string, file: string, kind: 'directory' | 'file'): fs.Stats {
  const relative = path.relative(root, file)
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Runtime fora da pasta autorizada.')
  let current = root
  const segments = relative.split(path.sep)
  for (let index = 0; index <= segments.length; index++) {
    const stat = fs.lstatSync(current)
    const final = index === segments.length
    if (stat.isSymbolicLink() || !(final && kind === 'file' ? stat.isFile() : stat.isDirectory())) {
      throw new Error('A pasta do runtime contém um link simbólico ou caminho inválido.')
    }
    if (final) return stat
    current = path.join(current, segments[index]!)
  }
  throw new Error('Caminho do runtime inválido.')
}

function ensureDirectory(root: string, directory: string): void {
  if (!optionalStat(directory)) fs.mkdirSync(directory, { mode: 0o700 })
  assertScoped(root, directory, 'directory')
}

function resolveNpm(node: string, environment: NodeJS.ProcessEnv): string {
  const bin = path.dirname(node)
  const candidates = [path.resolve(bin, '../lib/node_modules/npm/bin/npm-cli.js'), path.join(bin, 'node_modules/npm/bin/npm-cli.js')]
  if (environment.npm_execpath && path.isAbsolute(environment.npm_execpath)) candidates.push(environment.npm_execpath)
  for (const directory of (environment.PATH ?? environment.Path ?? '').split(path.delimiter)) {
    if (path.isAbsolute(directory)) candidates.push(path.join(directory, 'npm'), path.join(directory, 'node_modules/npm/bin/npm-cli.js'))
  }
  for (const candidate of candidates) {
    try {
      const resolved = fs.realpathSync(candidate)
      if (path.basename(resolved) === 'npm-cli.js' && fs.statSync(resolved).isFile()) return resolved
    } catch (error) {
      if (!missing(error) && (error as NodeJS.ErrnoException).code !== 'ENOTDIR') throw error
    }
  }
  throw new Error('O gerenciador de dependências não está disponível neste ambiente. Reabra o projeto no agente e retome a preparação.')
}

async function nodeVersion(node: string, cwd: string, io: ProjectRuntimeIO): Promise<string> {
  const environment = { ...io.env }
  delete environment.NODE_OPTIONS
  delete environment.NODE_PATH
  const version = (await io.run(node, ['--version'], { cwd, env: environment, timeout: 10_000 })).trim()
  if (!/^v\d+\.\d+\.\d+$/.test(version)) throw new Error('O executável de Node não retornou uma versão válida.')
  return version
}

/** Called only by an explicit, consented preparation/bootstrap action. This is
 * deliberately separate from status and readiness inspection. No globals,
 * shell startup files, system installation, or live preview are changed. */
async function projectRuntime(cwd: string, stack: ProjectStack | null, install: boolean, supplied?: ProjectRuntimeIO): Promise<ProjectRuntime | null> {
  const io = supplied ?? { node: process.execPath, env: process.env, platform: process.platform, arch: process.arch, run }
  const suppliedRoot = path.resolve(cwd)
  const rootStat = fs.lstatSync(suppliedRoot)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('A pasta do projeto deve ser um diretório real.')
  const root = fs.realpathSync(suppliedRoot)
  const currentNode = fs.realpathSync(io.node)
  const npm = resolveNpm(currentNode, io.env)
  const result = (node: string, version: string, source: ProjectRuntime['source']): ProjectRuntime => ({
    node, npm, env: projectRuntimeEnvironment(node, npm, io.env, io.platform), version, source,
  })
  const currentVersion = await nodeVersion(currentNode, root, io)
  if (compatibleProjectNode(stack, currentVersion)) return result(currentNode, currentVersion, 'current')

  const packageName = projectNodePackage(io.platform, io.arch)
  const supremo = path.join(root, '.supremo')
  const runtime = path.join(supremo, 'runtime')
  // Check each parent before creating or even looking up children beneath it.
  for (const directory of [supremo, runtime]) {
    if (install) ensureDirectory(root, directory)
    else {
      if (!optionalStat(directory)) return null
      assertScoped(root, directory, 'directory')
    }
  }
  const destination = path.join(runtime, `node-${PROJECT_NODE_VERSION}-${io.platform}-${io.arch}`)
  const binaryRelative = path.join('node_modules', packageName, 'bin', io.platform === 'win32' ? 'node.exe' : 'node')
  const binary = path.join(destination, binaryRelative)
  if (optionalStat(destination)) {
    assertScoped(root, destination, 'directory')
    assertScoped(root, binary, 'file')
    const version = await nodeVersion(binary, root, io)
    if (version !== `v${PROJECT_NODE_VERSION}`) throw new Error('O runtime local não corresponde à versão preparada. A instalação existente foi preservada.')
    return result(binary, version, 'project')
  }
  if (!install) return null

  const staging = fs.mkdtempSync(path.join(runtime, '.install-'))
  const identity = assertScoped(root, staging, 'directory')
  const assertStage = (): void => {
    const current = assertScoped(root, staging, 'directory')
    if (current.ino !== identity.ino || current.dev !== identity.dev) throw new Error('A pasta do runtime mudou durante a preparação.')
  }
  try {
    fs.writeFileSync(path.join(staging, 'package.json'), JSON.stringify({ name: 'supremo-project-runtime', private: true }), { flag: 'wx', mode: 0o600 })
    for (const filename of ['.npmrc', 'global.npmrc']) fs.writeFileSync(path.join(staging, filename), '', { flag: 'wx', mode: 0o600 })
    for (const directory of ['home', 'tmp', 'cache']) fs.mkdirSync(path.join(staging, directory), { mode: 0o700 })
    // No ambient npm configuration, auth tokens, project env file or lifecycle
    // script participates in the runtime download. Every writable path is local.
    const installEnv: NodeJS.ProcessEnv = {
      PATH: path.dirname(currentNode), HOME: path.join(staging, 'home'), USERPROFILE: path.join(staging, 'home'),
      TMPDIR: path.join(staging, 'tmp'), TMP: path.join(staging, 'tmp'), TEMP: path.join(staging, 'tmp'),
    }
    for (const name of ['SystemRoot', 'SYSTEMROOT', 'WINDIR']) if (io.env[name]) installEnv[name] = io.env[name]
    assertStage()
    await io.run(currentNode, [npm, 'install', `${packageName}@${PROJECT_NODE_VERSION}`,
      '--prefix', staging, '--registry', REGISTRY, '--userconfig', path.join(staging, '.npmrc'),
      '--globalconfig', path.join(staging, 'global.npmrc'), '--cache', path.join(staging, 'cache'),
      '--ignore-scripts', '--no-bin-links', '--no-audit', '--no-fund', '--package-lock=false', '--save=false',
      '--fetch-retries=1', '--fetch-timeout=30000', '--loglevel=error'], { cwd: staging, env: installEnv, timeout: 120_000 })
    assertStage()
    const stagedBinary = path.join(staging, binaryRelative)
    assertScoped(root, stagedBinary, 'file')
    const version = await nodeVersion(stagedBinary, root, io)
    if (version !== `v${PROJECT_NODE_VERSION}`) throw new Error('A versão instalada não corresponde à versão solicitada.')
    assertStage()
    if (optionalStat(destination)) throw new Error('Outra preparação criou o runtime local; retome a preparação para reutilizá-lo.')
    fs.renameSync(staging, destination)
    assertScoped(root, binary, 'file')
    return result(binary, version, 'installed')
  } catch {
    // Never include npm output, paths from exceptions, or environment values.
    throw new Error('Não foi possível preparar o Node local do projeto. Verifique a conexão e a permissão da pasta e retome a preparação; nenhuma instalação global foi alterada.')
  } finally {
    if (optionalStat(staging)) {
      assertStage()
      fs.rmSync(staging, { recursive: true, force: true })
    }
  }
}

/** Read-only discovery for later CLI invocations and status. Never downloads
 * packages, creates folders or changes a running preview. */
export function lookupProjectRuntime(cwd: string, stack: ProjectStack | null, supplied?: ProjectRuntimeIO): Promise<ProjectRuntime | null> {
  return projectRuntime(cwd, stack, false, supplied)
}

export async function ensureProjectRuntime(cwd: string, stack: ProjectStack | null, supplied?: ProjectRuntimeIO): Promise<ProjectRuntime> {
  const runtime = await projectRuntime(cwd, stack, true, supplied)
  if (!runtime) throw new Error('O runtime do projeto não foi preparado.')
  return runtime
}
