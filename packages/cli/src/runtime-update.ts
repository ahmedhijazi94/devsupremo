import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { daemonStatus, ensureDaemon, stopDaemon } from './daemon'
import { readStableFile } from './stable-file'
import { inspectRuntimeVersions } from './runtime-version'
import { gitText, readJson, withTurnLock, writeJson } from './turn-workspace'
import { runWorkerProcess } from './worker-process'
import { controlRuntimeService, serviceStatus } from './runtime-service'
import { ensureRuntimeDirectory } from './runtime-files'
import { RUNTIME_UPDATE_PATHS, runtimeUpdateAuthoritySchema } from './runtime-update-contract'
import { authorizeRuntimeUpdate } from './runtime-update-authority'
import { assertPreviewStopped, candidateWorktree, dependencySwapSchema, prepareDependencySwap, previewWitnessSchema, readPreviewWitness, restoreDependencies, swapDependencies } from './runtime-dependencies'

const TOOL_PATHS = RUNTIME_UPDATE_PATHS
const digest = (value: string): string => crypto.createHash('sha256').update(value).digest('hex')
const fileSchema = z.object({ path: z.enum(TOOL_PATHS), before: z.string().nullable(), after: z.string(),
  beforeDigest: z.string().nullable(), afterDigest: z.string() }).strict()
const planSchema = z.object({ version: z.literal(1), id: z.string().uuid(), base: z.string().regex(/^[a-f0-9]{40}$/),
  target: z.string().regex(/^[a-f0-9]{40}$/), status: z.enum(['planned', 'validated', 'applying', 'activating', 'active', 'rolled_back', 'conflict']),
  files: z.array(fileSchema), installedBefore: z.object({ manifest: z.string(), bundle: z.string() }).nullable(),
  previousDaemonRunning: z.boolean(), queueProtocolBefore: z.number().int().min(1).max(2),
  serviceWasActive: z.boolean(), serviceWasPaused: z.boolean(), createdAt: z.number(), error: z.string().optional(),
  authority: runtimeUpdateAuthoritySchema.optional(), templateVersion: z.string().optional(),
  preview: previewWitnessSchema.optional(), dependencies: dependencySwapSchema.optional() }).strict()
export type ToolUpdatePlan = z.infer<typeof planSchema>
const fileFor = (cwd: string, id: string): string => path.join(cwd, '.supremo/runtime-update', `${z.string().uuid().parse(id)}.json`)

function local(cwd: string, relative: string): string | null {
  const file = path.join(cwd, relative)
  if (!fs.lstatSync(file, { throwIfNoEntry: false })) return null
  return readStableFile(file, 32 * 1024 * 1024, cwd).content
}
function commitFile(cwd: string, ref: string, relative: string): string | null {
  const entry = gitText(cwd, ['ls-tree', ref, '--', relative])
  if (!entry) return null
  if (!/^100(?:644|755) blob [a-f0-9]{40}\t/.test(entry)) throw new Error(`Candidato contém arquivo não regular: ${relative}`)
  return execFileSync('git', ['show', `${ref}:${relative}`], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 })
}
function same(left: string | null, right: string | null): boolean { return left === right }
function save(cwd: string, plan: ToolUpdatePlan): void { ensureRuntimeDirectory(cwd, '.supremo/runtime-update'); writeJson(fileFor(cwd, plan.id), plan) }
export function readToolUpdate(cwd: string, id: string): ToolUpdatePlan { return planSchema.parse(JSON.parse(readStableFile(fileFor(cwd, id), 96 * 1024 * 1024, cwd).content)) }

/** The caller selects reviewed refs or the official server supplies a candidate.
 * Application code and the running preview are outside this allowlist. */
export function planToolUpdate(cwd: string, baseRef: string, targetRef: string, source?: { authority: z.infer<typeof runtimeUpdateAuthoritySchema>; templateVersion: string }): ToolUpdatePlan {
  const base = gitText(cwd, ['rev-parse', '--verify', `${baseRef}^{commit}`])
  const target = gitText(cwd, ['rev-parse', '--verify', `${targetRef}^{commit}`])
  if (!/^[a-f0-9]{40}$/.test(base) || !/^[a-f0-9]{40}$/.test(target)) throw new Error('Revisão de atualização inválida.')
  const files: ToolUpdatePlan['files'] = []
  for (const relative of TOOL_PATHS) {
    const before = commitFile(cwd, base, relative), after = commitFile(cwd, target, relative)
    if (before === after || after === null) continue
    const current = local(cwd, relative)
    if (!same(current, before) && !same(current, after)) throw new Error(`Personalização em ${relative}; combine as alterações antes de atualizar.`)
    files.push({ path: relative, before: current, after, beforeDigest: current === null ? null : digest(current), afterDigest: digest(after) })
  }
  if (!files.length && !source) throw new Error('Nenhuma ferramenta precisa de atualização nestas revisões.')
  let installedBefore: ToolUpdatePlan['installedBefore'] = null
  const installed = path.join(cwd, 'node_modules/supremo-cli')
  if (fs.existsSync(installed) && fs.realpathSync(installed) !== path.join(fs.realpathSync(cwd), 'tools/supremo-cli')) {
    const manifest = local(cwd, 'node_modules/supremo-cli/package.json'), bundle = local(cwd, 'node_modules/supremo-cli/dist/bin.js')
    if (manifest === null || bundle === null || bundle !== commitFile(cwd, base, 'tools/supremo-cli/dist/bin.js')) {
      throw new Error('CLI instalada diverge da base conhecida; nenhuma dependência ou preview foi alterado.')
    }
    installedBefore = { manifest, bundle }
  }
  const plan: ToolUpdatePlan = { version: 1, id: crypto.randomUUID(), base, target, status: 'planned', files,
    installedBefore, previousDaemonRunning: daemonStatus(cwd).running,
    queueProtocolBefore: inspectRuntimeVersions(cwd).active?.queueProtocol ?? 1,
    serviceWasActive: serviceStatus(cwd).state === 'active', serviceWasPaused: serviceStatus(cwd).state === 'paused', createdAt: Date.now(),
    preview: readPreviewWitness(cwd), ...source }
  save(cwd, plan)
  return plan
}
export interface ToolUpdateDeps {
  validate: (cwd: string, plan: ToolUpdatePlan) => Promise<void>
  stop: (cwd: string) => Promise<boolean>
  start: (cwd: string) => Promise<unknown>
  active: (cwd: string) => boolean
  installDependencies?: (cwd: string, scratch: string) => Promise<void>
}
const defaults = (plan: ToolUpdatePlan): ToolUpdateDeps => ({
  validate: async (cwd, plan) => {
    const scratch = path.join(cwd, '.supremo/runtime-update', `candidate-${plan.id}`)
    candidateWorktree(cwd, ['add', '--detach', scratch, plan.target])
    try {
      const bundle = path.join(scratch, 'tools/supremo-cli/dist/bin.js')
      const manifest = z.object({ name: z.literal('supremo-cli'), version: z.string() }).parse(JSON.parse(local(scratch, 'tools/supremo-cli/package.json') ?? 'null'))
      const env = { PATH: process.env.PATH, HOME: scratch, TMPDIR: scratch }
      await runWorkerProcess(process.execPath, ['--check', bundle], { cwd: scratch, env, timeoutMs: 10_000, maxOutputBytes: 64 * 1024 })
      const version = await runWorkerProcess(process.execPath, [bundle, '--version'], { cwd: scratch, env, timeoutMs: 10_000, maxOutputBytes: 64 * 1024 })
      if (version.stdout.trim() !== manifest.version) throw new Error('Versão executada diverge do manifesto candidato.')
      // A future official release carries its own trusted policy; the running
      // CLI cannot recognize hashes that had not yet been published at build time.
      const checked = await runWorkerProcess(process.execPath, [bundle, 'runtime', 'check-tools'], { cwd: scratch, env, timeoutMs: 10_000, maxOutputBytes: 64 * 1024 })
      z.object({ status: z.literal('verified') }).strict().parse(JSON.parse(checked.stdout.trim()))
    } finally { candidateWorktree(cwd, ['remove', '--force', scratch]) }
  }, stop: async cwd => {
    if (serviceStatus(cwd).state === 'active') await controlRuntimeService(cwd, 'pause')
    return stopDaemon(cwd)
  }, start: cwd => plan.serviceWasActive ? controlRuntimeService(cwd, 'resume') : ensureDaemon(cwd),
  active: cwd => inspectRuntimeVersions(cwd).compatible,
})
function writeLocal(cwd: string, relative: string, content: string | null): void {
  const file = path.join(cwd, relative)
  // Recheck all ancestors before writes; never traverse a new project symlink.
  const parts = relative.split('/')
  for (let i = 1; i < parts.length; i++) {
    const directory = path.join(cwd, ...parts.slice(0, i))
    const stat = fs.lstatSync(directory, { throwIfNoEntry: false })
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error('Atualização encontrou diretório não regular.')
    if (!stat) fs.mkdirSync(directory, { mode: 0o700 })
  }
  if (content === null) { fs.rmSync(file, { force: true }); return }
  const temporary = `${file}.${crypto.randomUUID()}.tmp`
  fs.writeFileSync(temporary, content, { flag: 'wx', mode: relative.endsWith('.mjs') || relative.endsWith('bin.js') || relative.startsWith('.githooks/') ? 0o755 : 0o644 })
  fs.renameSync(temporary, file)
}
function assertPlanIntegrity(cwd: string, plan: ToolUpdatePlan): void {
  for (const file of plan.files) {
    if (digest(file.after) !== file.afterDigest || (file.before === null ? null : digest(file.before)) !== file.beforeDigest ||
      file.after !== commitFile(cwd, plan.target, file.path) ||
      (file.before !== commitFile(cwd, plan.base, file.path) && file.before !== file.after)) throw new Error('Conteúdo do plano diverge da revisão validada.')
  }
}
function unfinishedDurableOperations(cwd: string): boolean {
  const directory = path.join(cwd, '.supremo/database-queue/operations')
  if (!fs.existsSync(directory)) return false
  return fs.readdirSync(directory).filter(name => /^[a-f0-9-]{36}\.json$/.test(name)).some(name => {
    const entry = z.object({ status: z.string() }).safeParse(readJson(path.join(directory, name)))
    return !entry.success || ['queued', 'running', 'uncertain', 'needs_authorization'].includes(entry.data.status)
  })
}
function requiresDependencyInstall(plan: ToolUpdatePlan): boolean {
  const packageChange = plan.files.find(file => file.path === 'package.json')
  if (packageChange) {
    const dependencies = (content: string | null): string => {
      const pkg = z.object({ dependencies: z.record(z.string(), z.string()).optional(), devDependencies: z.record(z.string(), z.string()).optional(),
        optionalDependencies: z.record(z.string(), z.string()).optional(), peerDependencies: z.record(z.string(), z.string()).optional(), overrides: z.unknown().optional() }).parse(JSON.parse(content ?? '{}'))
      return JSON.stringify([[pkg.dependencies, pkg.devDependencies, pkg.optionalDependencies, pkg.peerDependencies].map(values => Object.entries(values ?? {}).filter(([name]) => name !== 'supremo-cli').sort(([a], [b]) => a.localeCompare(b))), pkg.overrides])
    }
    if (dependencies(packageChange.before) !== dependencies(packageChange.after)) return true
  }
  const lockChange = plan.files.find(file => file.path === 'package-lock.json')
  if (!lockChange) return false
  const packages = (content: string | null): string => {
    const lock = z.object({ packages: z.record(z.string(), z.unknown()).optional() }).parse(JSON.parse(content ?? '{}'))
    return JSON.stringify(Object.entries(lock.packages ?? {}).filter(([name]) => name !== '' && name !== 'tools/supremo-cli' && name !== 'node_modules/supremo-cli').sort(([a], [b]) => a.localeCompare(b)))
  }
  return packages(lockChange.before) !== packages(lockChange.after)
}
export async function applyToolUpdate(cwd: string, id: string, overrides?: ToolUpdateDeps, options?: { withDependencies?: boolean }): Promise<ToolUpdatePlan> {
  const plan = readToolUpdate(cwd, id)
  const deps = overrides ?? defaults(plan)
  assertPlanIntegrity(cwd, plan)
  if (plan.status === 'active') return plan
  if (plan.status === 'activating' && plan.serviceWasPaused) {
    if (deps.active(cwd)) { plan.status = 'active'; delete plan.error; save(cwd, plan) }
    return plan
  }
  if (plan.status === 'rolled_back' || plan.status === 'conflict') throw new Error('Plano encerrado; prepare uma nova atualização com o estado atual.')
  if (plan.authority) await authorizeRuntimeUpdate(cwd, plan.authority)
  const needsDependencies = requiresDependencyInstall(plan)
  if (needsDependencies && !options?.withDependencies && !plan.dependencies) {
    plan.error = `Plano ${plan.id} preparado; exige instalação isolada. Pare o preview na janela autorizada e execute runtime apply-update ${plan.id} --with-dependencies. Nenhum arquivo ou preview foi alterado.`; save(cwd, plan)
    throw new Error(plan.error)
  }
  if (plan.status === 'planned') { await deps.validate(cwd, plan); plan.status = 'validated'; save(cwd, plan) }
  if (needsDependencies) {
    try {
      await assertPreviewStopped(cwd, plan.preview)
      if (!plan.dependencies) {
        plan.dependencies = await prepareDependencySwap(cwd, plan.id, plan.target, deps.installDependencies)
        save(cwd, plan)
      }
    } catch (error) { plan.error = error instanceof Error ? error.message : 'Instalação isolada falhou.'; save(cwd, plan); throw error }
  }
  return withTurnLock(cwd, async () => {
    const lease = readJson(path.join(cwd, '.supremo/turns/mutation-lease.json'))
    if (lease !== null) throw new Error('Ferramenta ativa; atualização aguarda um momento seguro.')
    for (const file of plan.files) {
      const current = local(cwd, file.path)
      if (!same(current, file.before) && !same(current, file.after)) {
        plan.status = 'conflict'; plan.error = `Edição concorrente em ${file.path}; arquivos preservados.`; save(cwd, plan); return plan
      }
    }
    if (plan.authority) await authorizeRuntimeUpdate(cwd, plan.authority)
    if (needsDependencies) await assertPreviewStopped(cwd, plan.preview)
    if (!await deps.stop(cwd)) throw new Error('Não foi possível confirmar a parada do daemon; atualização não aplicada.')
    plan.status = 'applying'; save(cwd, plan)
    try {
      if (needsDependencies) await assertPreviewStopped(cwd, plan.preview)
      if (plan.dependencies) swapDependencies(cwd, plan.id, plan.dependencies, () => save(cwd, plan))
      for (const file of plan.files) writeLocal(cwd, file.path, file.after)
      if (plan.installedBefore && !plan.dependencies) {
        writeLocal(cwd, 'node_modules/supremo-cli/package.json', local(cwd, 'tools/supremo-cli/package.json'))
        writeLocal(cwd, 'node_modules/supremo-cli/dist/bin.js', local(cwd, 'tools/supremo-cli/dist/bin.js'))
      }
      plan.status = 'activating'; save(cwd, plan)
      if (plan.serviceWasPaused) {
        plan.error = 'Ferramentas atualizadas; serviço permanece pausado por solicitação do dono. Ativação aguarda retomada explícita.'
        save(cwd, plan); return plan
      }
      await deps.start(cwd)
      const deadline = Date.now() + 5000
      while (!deps.active(cwd) && Date.now() < deadline) await new Promise<void>(resolve => setTimeout(resolve, 100))
      if (!deps.active(cwd)) throw new Error('Nova versão ainda não confirmada pelo daemon.')
      plan.status = 'active'; delete plan.error; save(cwd, plan); return plan
    } catch (error) {
      plan.error = error instanceof Error ? error.message : 'Ativação falhou.'
      // Stop the candidate before restoring executable bytes. The queue format is
      // unchanged in this release; incompatible future migrations must refuse this path.
      const installedChanged = !plan.dependencies && plan.installedBefore && [
        ['node_modules/supremo-cli/package.json', plan.installedBefore.manifest, local(cwd, 'tools/supremo-cli/package.json')],
        ['node_modules/supremo-cli/dist/bin.js', plan.installedBefore.bundle, local(cwd, 'tools/supremo-cli/dist/bin.js')],
      ].some(([relative, before, after]) => { const current = local(cwd, relative!); return current !== before && current !== after })
      if (plan.queueProtocolBefore < 2 && unfinishedDurableOperations(cwd)) {
        plan.status = 'conflict'; plan.error += ' Downgrade bloqueado: há operações no formato novo; mantenha um executor compatível para reconciliá-las.'; save(cwd, plan); return plan
      }
      if (!await deps.stop(cwd) || installedChanged || plan.files.some(file => !same(local(cwd, file.path), file.before) && !same(local(cwd, file.path), file.after))) {
        plan.status = 'conflict'; save(cwd, plan); return plan
      }
      if (plan.dependencies) {
        try { await assertPreviewStopped(cwd, plan.preview); restoreDependencies(cwd, plan.id, plan.dependencies, () => save(cwd, plan)) }
        catch { plan.status = 'conflict'; plan.error += ' Dependências preservadas: rollback não confirmou uma janela segura ou encontrou instalação concorrente.'; save(cwd, plan); return plan }
      }
      for (const file of plan.files) writeLocal(cwd, file.path, file.before)
      if (plan.installedBefore && !plan.dependencies) {
        writeLocal(cwd, 'node_modules/supremo-cli/package.json', plan.installedBefore.manifest)
        writeLocal(cwd, 'node_modules/supremo-cli/dist/bin.js', plan.installedBefore.bundle)
      }
      plan.status = 'rolled_back'; save(cwd, plan)
      if (plan.previousDaemonRunning) await deps.start(cwd)
      return plan
    }
  })
}
