import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { resolveProjectStack, type ProjectStack } from './project-stack'
import { readStableFile } from './stable-file'
import { WorkerAbortedError, WorkerTimeoutError } from './worker-process'

const packageEvidence = z.object({
  dependencies: z.record(z.string(), z.string()).optional(),
  devDependencies: z.record(z.string(), z.string()).optional(),
})
const projectEvidence = z.object({ stack: z.string().optional(), scaffoldVersion: z.string().optional() })

function optionalFile(cwd: string, relative: string): string | undefined {
  try { return readStableFile(path.join(cwd, relative), 1024 * 1024, cwd).content }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/** Metadata confirms package/config evidence; it never selects executable text.
 * Unidentified legacy/imported projects remain unidentified, never new-default. */
export function readProjectStack(cwd: string): ProjectStack | null {
  const packageText = optionalFile(cwd, 'package.json')
  const projectText = optionalFile(cwd, '.supremo/project.json')
  const pkg = packageEvidence.parse(packageText === undefined ? {} : JSON.parse(packageText))
  const project = projectEvidence.parse(projectText === undefined ? {} : JSON.parse(projectText))
  const stack = resolveProjectStack({
    ...(pkg.dependencies === undefined ? {} : { dependencies: pkg.dependencies }),
    ...(pkg.devDependencies === undefined ? {} : { devDependencies: pkg.devDependencies }),
    ...(project.stack === undefined ? {} : { declaredStack: project.stack }),
    ...(project.scaffoldVersion === undefined ? {} : { scaffoldVersion: project.scaffoldVersion }),
  })
  if (stack === 'tanstack-start-vite') {
    const configs = ['vite.config.mts', 'vite.config.ts', 'vite.config.mjs', 'vite.config.js']
      .map(file => optionalFile(cwd, file)).filter((content): content is string => content !== undefined)
    if (configs.length !== 1 || !/from\s*['"]@tanstack\/react-start\/plugin\/vite['"]/.test(configs[0] ?? '')) {
      throw new Error('Configuração TanStack Start ausente ou ambígua; stack não será convertida automaticamente.')
    }
    if (['next.config.ts', 'next.config.mjs', 'next.config.js'].some(file => optionalFile(cwd, file) !== undefined)) {
      throw new Error('Configurações Next e TanStack conflitantes; operação recusada.')
    }
  }
  return stack
}

/** Only these two public integration values can change framework prefixes.
 * No arbitrary NEXT_PUBLIC_* conversion, private key or caller command. */
export function publicSupabaseEnvironment(stack: ProjectStack | null, source: Record<string, string>): Record<string, string> {
  const prefix = stack === 'tanstack-start-vite' ? 'VITE_' : 'NEXT_PUBLIC_'
  const result: Record<string, string> = {}
  for (const suffix of ['SUPABASE_URL', 'SUPABASE_ANON_KEY'] as const) {
    const legacy = source[`NEXT_PUBLIC_${suffix}`], start = source[`VITE_${suffix}`]
    if (legacy !== undefined && start !== undefined && legacy !== start) throw new Error('Variáveis públicas do banco divergem; operação recusada.')
    const value = stack === 'tanstack-start-vite' ? start ?? legacy : legacy
    if (value !== undefined) {
      if (/[\r\n\0]/.test(value)) throw new Error('Variável pública inválida.')
      result[`${prefix}${suffix}`] = value
    }
  }
  return result
}

export function syntheticValidationEnvironment(stack: ProjectStack | null): Record<string, string> {
  return publicSupabaseEnvironment(stack, {
    NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:9',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'supremo-synthetic-smoke-key',
  })
}

/** The new pinned Start/tooling combination has a higher Node requirement;
 * retain the historical advisory behavior for other workspaces. */
export function assertFrameworkNodeVersion(stack: ProjectStack | null, version: string): void {
  if (stack !== 'tanstack-start-vite') return
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version)
  const major = Number(match?.[1]), minor = Number(match?.[2])
  if (!match || major < 22 || major === 23 || (major === 22 && minor < 13)) {
    throw new Error('TanStack Start requer Node 22.13+ (linha 22) ou >= 24. Use Node 22 LTS antes do bootstrap.')
  }
}

/** Preserve the legacy Next/imported-project layout. Top-level build caches stay
 * in the snapshot, while installed packages and their executable paths are reused. */
export async function linkLegacyDependencies(cwd: string, scratch: string): Promise<void> {
  const source = path.join(cwd, 'node_modules'), target = path.join(scratch, 'node_modules')
  await fs.promises.mkdir(target)
  for (const name of await fs.promises.readdir(source)) {
    if (!name.startsWith('.')) await fs.promises.symlink(path.join(source, name), path.join(target, name))
  }
}

/** Clone dependencies into the immutable worktree. Symlinked Start/Nitro entry
 * modules resolve outside Vite's strict filesystem boundary and return HTTP 500.
 * Reflinks avoid duplicating file data on supporting filesystems; ordinary copies
 * remain safe elsewhere. Neither package writes nor caches can touch the preview.
 * Binaries retain relative links into this private dependency tree. */
export async function linkIsolatedDependencies(cwd: string, scratch: string, options: {
  signal?: AbortSignal | undefined; deadline?: number | undefined
} = {}): Promise<void> {
  const budget = options.deadline === undefined ? undefined : Math.max(1, options.deadline - Date.now())
  const checkBudget = (): void => {
    if (options.signal?.aborted) throw new WorkerAbortedError()
    if (options.deadline !== undefined && Date.now() >= options.deadline) throw new WorkerTimeoutError(budget ?? 1)
  }
  checkBudget()
  const source = await fs.promises.realpath(path.join(cwd, 'node_modules')), target = path.join(scratch, 'node_modules')
  checkBudget()
  await fs.promises.mkdir(target)
  for (const name of await fs.promises.readdir(source)) {
    checkBudget()
    if (!name.startsWith('.')) await fs.promises.cp(path.join(source, name), path.join(target, name), {
      recursive: true, dereference: true, mode: fs.constants.COPYFILE_FICLONE,
      // This callback also bounds large package trees and symbolic-link cycles.
      // Async I/O lets the daemon receive cancellation while a copy is running.
      filter: () => { checkBudget(); return true },
    })
  }
  checkBudget()
  const bins = path.join(source, '.bin')
  let names: string[]
  try { names = await fs.promises.readdir(bins) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    checkBudget()
    return
  }
  checkBudget()
  await fs.promises.mkdir(path.join(target, '.bin'))
  for (const name of names) {
    checkBudget()
    const original = path.join(bins, name), destination = path.join(target, '.bin', name)
    const stat = await fs.promises.lstat(original)
    checkBudget()
    if (stat.isFile()) {
      await fs.promises.copyFile(original, destination, fs.constants.COPYFILE_FICLONE)
      continue
    }
    if (!stat.isSymbolicLink()) throw new Error('Executável de validação não é um arquivo regular nem link simbólico.')
    const resolved = await fs.promises.realpath(original)
    checkBudget()
    const relative = path.relative(source, resolved)
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
      // Local file dependencies (e.g. the bundled engine) need no validation
      // executable. Do not link outside the private copy.
      continue
    }
    await fs.promises.symlink(path.relative(path.join(target, '.bin'), path.join(target, relative)), destination)
  }
  checkBudget()
}

/** Exact allowlist. The script's bytes are validated by verifyTrustedFiles
 * before this adapter is used. Caller metadata cannot provide script paths. */
export function routePreparation(stack: ProjectStack | null, cwd: string, scratch: string): { command: string; args: string[] } | null {
  if (stack === 'nextjs') return { command: path.join(cwd, 'node_modules/next/dist/bin/next'), args: ['typegen'] }
  if (stack === 'tanstack-start-vite') {
    const script = path.join(scratch, 'scripts/generate-routes.mjs')
    readStableFile(script, 256 * 1024, scratch)
    return { command: script, args: [] }
  }
  return null
}
