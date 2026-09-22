import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { resolveProjectStack, type ProjectStack } from './project-stack'
import { readStableFile } from './stable-file'

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

/** Keep Vite's hidden caches private to the immutable worktree. Installed
 * dependencies may be reused; the live node_modules directory may not be. */
export function linkIsolatedDependencies(cwd: string, scratch: string): void {
  const source = path.join(cwd, 'node_modules'), target = path.join(scratch, 'node_modules')
  fs.mkdirSync(target)
  for (const name of fs.readdirSync(source)) {
    if (!name.startsWith('.')) fs.symlinkSync(path.join(source, name), path.join(target, name))
  }
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
