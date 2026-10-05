import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { z } from 'zod'
import { processState } from './daemon-lifecycle'
import { readProjectStack } from './framework-runtime'
import { lookupProjectRuntime } from './project-runtime'
import { ensureRuntimeDirectory } from './runtime-files'
import { readStableFile } from './stable-file'
import { runWorkerProcess } from './worker-process'

export const previewWitnessSchema = z.object({ pid: z.number().int().positive(), port: z.number().int().min(1).max(65535) }).strict()
const identitySchema = z.object({ dev: z.number(), ino: z.number(), lockDigest: z.string().nullable() }).strict()
export const dependencySwapSchema = z.object({ state: z.enum(['prepared', 'swapping', 'installed', 'rolled_back']),
  before: identitySchema.nullable(), after: identitySchema }).strict()
export type PreviewWitness = z.infer<typeof previewWitnessSchema>
export type DependencySwap = z.infer<typeof dependencySwapSchema>
type Identity = z.infer<typeof identitySchema>
const area = (cwd: string, id: string): string => path.join(cwd, '.supremo/runtime-update', `dependencies-${z.string().uuid().parse(id)}`)
const backup = (cwd: string, id: string): string => path.join(cwd, '.supremo/runtime-update', `modules-${z.string().uuid().parse(id)}-before`)

export function candidateWorktree(cwd: string, args: string[]): void {
  const root = ensureRuntimeDirectory(cwd, '.supremo/runtime-update')
  const empty = fs.mkdtempSync(path.join(root, 'git-safety-'))
  const env = { PATH: process.env.PATH, HOME: empty, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(empty, 'no-global-config') }
  try {
    // Local checkout filters can execute code just like post-checkout hooks.
    let filters = ''
    try { filters = execFileSync('git', ['config', '--name-only', '--get-regexp', '^filter\\..*\\.(smudge|process|required)$'], { cwd, env, encoding: 'utf8', stdio: 'pipe' }) }
    catch (error) { if ((error as { status?: number }).status !== 1) throw error }
    const disabledFilters = filters.trim().split('\n').filter(Boolean).flatMap(key => ['-c', `${key}=${key.endsWith('.required') ? 'false' : ''}`])
    execFileSync('git', ['-c', `core.hooksPath=${empty}`, '-c', 'core.fsmonitor=false', ...disabledFilters, 'worktree', ...args], { cwd, env, stdio: 'pipe' })
  } finally { fs.rmSync(empty, { recursive: true, force: true }) }
}

export function readPreviewWitness(cwd: string): PreviewWitness | undefined {
  const read = (name: string): number | undefined => {
    const file = path.join(cwd, '.supremo', name)
    return fs.lstatSync(file, { throwIfNoEntry: false }) ? Number(readStableFile(file, 128, cwd).content.trim()) : undefined
  }
  const pid = read('preview.pid'), port = read('preview.port')
  if (pid === undefined && port === undefined) return undefined
  return previewWitnessSchema.parse({ pid, port })
}

export function portIsClosed(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port })
    let settled = false
    const finish = (closed: boolean): void => { if (!settled) { settled = true; socket.destroy(); resolve(closed) } }
    socket.once('connect', () => finish(false))
    socket.once('error', error => finish((error as NodeJS.ErrnoException).code === 'ECONNREFUSED'))
    socket.setTimeout(1000, () => finish(false))
  })
}

/** stop removes its pidfile before the process exits. Retain the observation
 * from preparation, and require both process death and a closed socket. */
export async function assertPreviewStopped(cwd: string, witness: PreviewWitness | undefined): Promise<void> {
  if (!witness) throw new Error('Prepare o plano com o preview supervisionado identificado, pare o preview e retome este plano com --with-dependencies; faltou a prova de PID e porta.')
  const current = readPreviewWitness(cwd)
  for (const observed of [witness, ...(current ? [current] : [])]) {
    if (processState(observed.pid) !== 'dead' || !await portIsClosed(observed.port)) {
      throw new Error('A janela de dependências exige preview parado: PID encerrado e porta fechada. Pare o preview e retome o mesmo plano.')
    }
  }
}

function identity(cwd: string, directory: string): Identity | null {
  const relative = path.relative(cwd, directory)
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Dependências fora do projeto.')
  let current = cwd
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment)
    const stat = fs.lstatSync(current, { throwIfNoEntry: false })
    if (!stat) return null
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Dependências exigem diretórios regulares; links preservados.')
  }
  const stat = fs.statSync(directory)
  const lock = path.join(directory, '.package-lock.json')
  const lockDigest = fs.lstatSync(lock, { throwIfNoEntry: false })
    ? crypto.createHash('sha256').update(readStableFile(lock, 32 * 1024 * 1024, cwd).content).digest('hex') : null
  return { dev: stat.dev, ino: stat.ino, lockDigest }
}
const matches = (left: Identity | null, right: Identity | null): boolean => JSON.stringify(left) === JSON.stringify(right)

/** Install only public registry tarballs and the two checked-in runtime tools.
 * Project npm config, lifecycle hooks and ambient credentials are excluded. */
export async function installDependencyCandidate(cwd: string, scratch: string): Promise<void> {
  const dependencyMap = z.record(z.string(), z.string()).optional()
  const pkg = z.object({ workspaces: z.unknown().optional(), dependencies: dependencyMap, devDependencies: dependencyMap,
    optionalDependencies: dependencyMap }).passthrough().parse(JSON.parse(readStableFile(path.join(scratch, 'package.json'), 1024 * 1024, scratch).content))
  if (pkg.workspaces !== undefined) throw new Error('Workspaces exigem uma atualização de dependências revisada separadamente.')
  const lock = z.object({ lockfileVersion: z.number().min(2), packages: z.record(z.string(), z.object({ resolved: z.string().optional(), link: z.boolean().optional(), integrity: z.string().optional() }).passthrough()) }).passthrough()
    .parse(JSON.parse(readStableFile(path.join(scratch, 'package-lock.json'), 32 * 1024 * 1024, scratch).content))
  const localTools = new Set(['tools/supremo-cli', 'tools/next-eslint-glob'])
  for (const spec of Object.values({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies })) {
    if (/^(?:file:|link:)/.test(spec) && localTools.has(spec.replace(/^(?:file:|link:)/, ''))) continue
    if (!/^[~^<>=*\dvxX][\d\w.*+~^<>=| -]*$/.test(spec) && !/^[a-z][a-z0-9-]*$/.test(spec)) {
      throw new Error('Especificação de dependência exige revisão separada; instalação aceita versões do registry público ou ferramentas gerenciadas.')
    }
  }
  for (const [name, entry] of Object.entries(lock.packages)) {
    if (name && (path.posix.normalize(name) !== name || name.includes('\\') || name.startsWith('/'))) throw new Error('Caminho inválido no lockfile candidato.')
    if (name && !name.startsWith('node_modules/') && !localTools.has(name)) throw new Error('Dependência local fora das ferramentas gerenciadas; revisão separada necessária.')
    if (name.startsWith('node_modules/') && !entry.link && (!entry.resolved || !entry.integrity)) throw new Error('Lockfile sem origem e integridade verificáveis; revisão separada necessária.')
    if (entry.link && (!entry.resolved || !localTools.has(entry.resolved))) throw new Error('Link de dependência fora das ferramentas gerenciadas; revisão separada necessária.')
    if (entry.resolved !== undefined) {
      if (entry.link && localTools.has(entry.resolved)) continue
      const url = z.url().safeParse(entry.resolved)
      const parsed = url.success ? new URL(url.data) : null
      if (!parsed || parsed.origin !== 'https://registry.npmjs.org' || parsed.username || parsed.password || parsed.search || parsed.hash) {
        throw new Error('Instalação isolada aceita somente o registry público e ferramentas gerenciadas; revisão separada necessária.')
      }
    }
  }
  const runtime = await lookupProjectRuntime(cwd, readProjectStack(scratch))
  if (!runtime) throw new Error('Prepare primeiro o Node compatível do projeto; nenhuma dependência instalada foi alterada.')
  fs.rmSync(path.join(scratch, '.npmrc'), { force: true })
  const temporary = fs.mkdtempSync(path.join(scratch, '.supremo-install-'))
  const config = path.join(temporary, 'npmrc'), globalConfig = path.join(temporary, 'global-npmrc')
  fs.writeFileSync(config, ''); fs.writeFileSync(globalConfig, '')
  const env = { PATH: path.dirname(runtime.node), HOME: temporary, TMPDIR: temporary, CI: 'true' }
  try {
    await runWorkerProcess(runtime.node, [runtime.npm, 'ci', '--ignore-scripts', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org/',
      `--userconfig=${config}`, `--globalconfig=${globalConfig}`, `--cache=${path.join(temporary, 'cache')}`, '--fetch-retries=1', '--fetch-timeout=30000'],
    { cwd: scratch, env, timeoutMs: 300_000, maxOutputBytes: 512 * 1024 })
    await runWorkerProcess(runtime.node, [runtime.npm, 'ls', '--depth=0', '--offline', '--ignore-scripts', `--userconfig=${config}`, `--globalconfig=${globalConfig}`],
      { cwd: scratch, env, timeoutMs: 30_000, maxOutputBytes: 512 * 1024 })
    const cli = path.join(scratch, 'node_modules/supremo-cli')
    if (fs.lstatSync(cli, { throwIfNoEntry: false })) {
      if (fs.realpathSync(cli) !== path.join(scratch, 'tools/supremo-cli')) throw new Error('CLI instalada fora das ferramentas gerenciadas.')
      const manifest = z.object({ name: z.literal('supremo-cli'), version: z.string() }).parse(JSON.parse(readStableFile(path.join(scratch, 'tools/supremo-cli/package.json'), 64 * 1024, scratch).content))
      const result = await runWorkerProcess(runtime.node, [path.join(scratch, 'tools/supremo-cli/dist/bin.js'), '--version'], { cwd: scratch, env, timeoutMs: 10_000, maxOutputBytes: 64 * 1024 })
      if (result.stdout.trim() !== manifest.version) throw new Error('CLI instalada não executou a versão candidata.')
    }
    if (pkg.dependencies?.typescript || pkg.devDependencies?.typescript) {
      const compiler = path.join(scratch, 'node_modules/typescript/bin/tsc')
      readStableFile(compiler, 128 * 1024, scratch)
      const result = await runWorkerProcess(runtime.node, [compiler, '--version'], { cwd: scratch, env, timeoutMs: 10_000, maxOutputBytes: 64 * 1024 })
      if (!/^Version \d+\.\d+\.\d+/.test(result.stdout.trim())) throw new Error('Compilador candidato não executou.')
    }
  } catch { throw new Error('Instalação isolada não validou as dependências candidatas; projeto e instalação anterior preservados.') }
  finally { fs.rmSync(temporary, { recursive: true, force: true }) }
}

export async function prepareDependencySwap(cwd: string, id: string, target: string,
  install: (cwd: string, scratch: string) => Promise<void> = installDependencyCandidate): Promise<DependencySwap> {
  ensureRuntimeDirectory(cwd, '.supremo/runtime-update')
  const scratch = area(cwd, id)
  // An interrupted install is left for inspection, never adopted as validated.
  if (fs.lstatSync(scratch, { throwIfNoEntry: false })) throw new Error('Instalação candidata incompleta preservada; prepare um novo plano para tentar novamente.')
  const before = identity(cwd, path.join(cwd, 'node_modules'))
  candidateWorktree(cwd, ['add', '--detach', scratch, target])
  await install(cwd, scratch)
  const after = identity(cwd, path.join(scratch, 'node_modules'))
  if (!after) throw new Error('Instalação candidata não gerou node_modules.')
  return { state: 'prepared', before, after }
}

/** Persist intent before either rename. Directory identities let a restarted
 * updater finish either half without replacing a concurrent npm installation. */
export function swapDependencies(cwd: string, id: string, journal: DependencySwap, persist: () => void): void {
  const live = path.join(cwd, 'node_modules'), staged = path.join(area(cwd, id), 'node_modules'), old = backup(cwd, id)
  if (matches(identity(cwd, live), journal.after)) { journal.state = 'installed'; persist(); return }
  if (journal.state === 'installed' || journal.state === 'rolled_back') throw new Error('Instalação de dependências mudou após a troca; arquivos preservados.')
  if (!matches(identity(cwd, staged), journal.after)) throw new Error('Candidato de dependências mudou; arquivos preservados.')
  const current = identity(cwd, live), saved = identity(cwd, old)
  if (!(matches(current, journal.before) && saved === null) && !(current === null && matches(saved, journal.before))) {
    throw new Error('Instalação de dependências concorrente; arquivos preservados.')
  }
  journal.state = 'swapping'; persist()
  if (current !== null) fs.renameSync(live, old)
  fs.renameSync(staged, live)
  journal.state = 'installed'; persist()
}

export function restoreDependencies(cwd: string, id: string, journal: DependencySwap, persist: () => void): void {
  const live = path.join(cwd, 'node_modules'), staged = path.join(area(cwd, id), 'node_modules'), old = backup(cwd, id)
  const current = identity(cwd, live), saved = identity(cwd, old)
  if (matches(current, journal.before) && saved === null) { journal.state = 'rolled_back'; persist(); return }
  if (!matches(saved, journal.before) || (current !== null && !matches(current, journal.after))) throw new Error('Rollback de dependências encontrou instalação concorrente; arquivos preservados.')
  if (current !== null) {
    if (identity(cwd, staged) !== null) throw new Error('Rollback de dependências encontrou candidato concorrente; arquivos preservados.')
    fs.renameSync(live, staged)
  }
  if (saved !== null) fs.renameSync(old, live)
  journal.state = 'rolled_back'; persist()
}
