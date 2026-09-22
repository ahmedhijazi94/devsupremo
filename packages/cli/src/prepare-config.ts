import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { parse } from 'dotenv'
import { z } from 'zod'
import type { BootstrapConfig } from './bootstrap'
import { deviceIssuer } from './device-identity'
import type { DatabaseStatus } from './database'
import { publicSupabaseEnvironment } from './framework-runtime'
import type { ProjectStack } from './project-stack'
import { readStableFile } from './stable-file'

const identitySchema = z.object({ projectId: z.string().uuid(), supremoUrl: z.string() })
const databaseSchema = z.object({
  environment: z.enum(['development', 'production', 'unknown']),
  projectRef: z.string().regex(/^[a-z0-9_-]+$/).max(64).nullable(),
  automaticMigrations: z.boolean(),
})
export type PrepareDatabase = z.infer<typeof databaseSchema>
const onboardingSchema = z.object({ version: z.literal(1), projectId: z.string().uuid(), issuer: z.string(),
  acceptedAt: z.string().datetime(), scope: z.literal('project-development') }).strict()

export class PreparationDeviceUnauthorizedError extends Error {
  constructor() {
    super('O Supremo recusou a identidade do dispositivo (HTTP 401).')
    this.name = 'PreparationDeviceUnauthorizedError'
  }
}

/** Replace the setup file itself, never a symlink/hardlink target. */
export function writeSetupFile(cwd: string, relative: string, content: string): void {
  const file = path.resolve(cwd, relative)
  const segments = path.relative(path.resolve(cwd), file).split(path.sep)
  if (!segments.length || segments.includes('..') || path.isAbsolute(path.relative(cwd, file))) throw new Error('Configuração fora do checkout.')
  for (let index = 0; index < segments.length; index++) {
    const directory = path.join(cwd, ...segments.slice(0, index))
    const stat = fs.lstatSync(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Diretório de configuração inválido.')
  }
  optionalSetupFile(cwd, relative)
  const temporary = path.join(path.dirname(file), `.prepare-${randomUUID()}.tmp`)
  try {
    fs.writeFileSync(temporary, content, { mode: 0o600, flag: 'wx' })
    fs.renameSync(temporary, file)
  } finally { fs.rmSync(temporary, { force: true }) }
}

/** Informational consent receipt for the explicit prepare invocation. It is
 * never used by device, database or host authorization checks. */
export function recordPreparationConsent(cwd: string, projectId: string, issuer: string): void {
  const canonical = deviceIssuer(issuer)
  const source = optionalSetupFile(cwd, '.supremo/onboarding.json')
  let prior: unknown
  try { prior = source === null ? null : JSON.parse(source) as unknown }
  catch { prior = null }
  const receipt = onboardingSchema.safeParse(prior)
  if (receipt.success && receipt.data.projectId === projectId && receipt.data.issuer === canonical) return
  const value = onboardingSchema.parse({ version: 1, projectId, issuer: canonical,
    acceptedAt: new Date().toISOString(), scope: 'project-development' })
  writeSetupFile(cwd, '.supremo/onboarding.json', JSON.stringify(value, null, 2) + '\n')
}

/** The database CLI's read-only status contract, with no cache mutation before
 * matching the returned target. A local snapshot never supplies this authority. */
export async function confirmPreparationDatabase(projectId: string, issuer: string, secret: string, expected: PrepareDatabase): Promise<DatabaseStatus> {
  z.string().uuid().parse(projectId)
  const response = await fetch(`${deviceIssuer(issuer)}/api/database`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId, deviceSecret: secret, operation: 'status' }),
  })
  if (response.status === 401) throw new PreparationDeviceUnauthorizedError()
  if (!response.ok) throw new Error(`Não foi possível confirmar o banco development (HTTP ${response.status}).`)
  const source = await response.text()
  if (Buffer.byteLength(source) > 16 * 1024) throw new Error('Resposta de banco excede o limite.')
  const current = databaseSchema.parse(JSON.parse(source))
  developmentDatabase(current)
  if (current.projectRef !== expected.projectRef) throw new Error('O banco remoto diverge do configurado; valores existentes preservados.')
  return current
}

export function optionalSetupFile(cwd: string, relative: string): string | null {
  try { return readStableFile(path.join(cwd, relative), 1024 * 1024, cwd).content }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // A dangling symlink is not a missing configuration file we may create.
      const candidate = path.join(cwd, relative)
      try { if (fs.lstatSync(candidate).isSymbolicLink()) throw new Error('Arquivo de configuração contém link simbólico.') }
      catch (inspection) { if ((inspection as NodeJS.ErrnoException).code !== 'ENOENT') throw inspection }
      return null
    }
    throw error
  }
}

/** A caller supplies the trusted issuer; checkout metadata can only confirm it. */
export function checkoutProject(cwd: string, issuer: string, expectedId?: string): string {
  const source = optionalSetupFile(cwd, '.supremo/project.json')
  if (source === null) throw new Error('.supremo/project.json ausente; prepare requer um checkout existente do Supremo.')
  const identity = identitySchema.parse(JSON.parse(source))
  if ((expectedId !== undefined && identity.projectId !== expectedId) || deviceIssuer(identity.supremoUrl) !== deviceIssuer(issuer)) {
    throw new Error('Projeto ou origem do checkout diverge da autorização. Nenhuma credencial foi enviada.')
  }
  return identity.projectId
}

function githubRepository(remote: string): string {
  const ssh = /^git@github\.com:([^\s]+)$/.exec(remote)
  let repository = ssh?.[1]
  if (repository === undefined) {
    const url = new URL(remote)
    if (url.hostname !== 'github.com' || !['https:', 'ssh:'].includes(url.protocol) || url.password ||
      (url.username && !(url.protocol === 'ssh:' && url.username === 'git')) || url.port || url.search || url.hash) {
      throw new Error('Remote do projeto inválido; use a URL limpa do GitHub.')
    }
    repository = url.pathname.slice(1)
  }
  repository = repository.replace(/\.git$/, '')
  if (!/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+$/.test(repository) || ['.', '..'].includes(repository.split('/')[1] ?? '')) {
    throw new Error('Repositório do projeto inválido.')
  }
  return repository.toLowerCase()
}

export function verifyCheckoutRepository(cwd: string, repo?: BootstrapConfig['repo']): void {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  if (fs.realpathSync(root) !== fs.realpathSync(cwd)) throw new Error('Prepare deve ser executado na raiz do checkout.')
  const remote = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const actual = githubRepository(remote)
  if (repo !== undefined && (actual !== githubRepository(repo.url) || actual !== githubRepository(`https://github.com/${repo.fullName}.git`))) {
    throw new Error('O remote do checkout diverge do repositório autorizado; preparação interrompida.')
  }
}

export function readSetupDatabase(cwd: string): PrepareDatabase | null {
  const source = optionalSetupFile(cwd, '.supremo/database.json')
  return source === null ? null : databaseSchema.parse(JSON.parse(source))
}

function developmentDatabase(database: PrepareDatabase): void {
  if (database.environment !== 'development') {
    throw new Error('Preparação automática requer banco development. Produção e ambiente desconhecido estão protegidos.')
  }
}

function publicValues(cwd: string, stack: ProjectStack | null): Record<string, string> {
  const parsed = parse(optionalSetupFile(cwd, '.env.local') ?? '')
  const normalized = publicSupabaseEnvironment(stack, parsed)
  // Prefix conversion is allowed for incoming config, but a legacy variable in
  // an existing file does not prove Vite can actually read its VITE_* name.
  return Object.fromEntries(Object.entries(normalized).filter(([name]) => parsed[name] !== undefined))
}

export function setupConfigurationComplete(cwd: string, stack: ProjectStack | null): boolean {
  const database = readSetupDatabase(cwd)
  if (database === null) return false
  developmentDatabase(database)
  const values = publicValues(cwd, stack)
  const prefix = stack === 'tanstack-start-vite' ? 'VITE_' : 'NEXT_PUBLIC_'
  const url = values[`${prefix}SUPABASE_URL`]
  const key = values[`${prefix}SUPABASE_ANON_KEY`]
  if (database.projectRef !== null) {
    if (url && url !== `https://${database.projectRef}.supabase.co`) throw new Error('O banco do preview diverge do development registrado; valores existentes preservados.')
    const linked = optionalSetupFile(cwd, 'supabase/.temp/project-ref')?.trim()
    if (linked && linked !== database.projectRef) throw new Error('O link local aponta para outro banco; preparação interrompida.')
    return Boolean(url && key)
  }
  if (url || key) throw new Error('Banco público configurado sem alvo development registrado.')
  return true
}

/** Writes setup data only. This snapshot never grants authority for database writes. */
export function configureAuthorizedCheckout(cwd: string, stack: ProjectStack | null, config: BootstrapConfig): PrepareDatabase {
  const incoming = databaseSchema.parse(config.database ?? {
    environment: 'unknown', projectRef: config.supabase?.projectRef ?? null, automaticMigrations: false,
  })
  developmentDatabase(incoming)
  if (config.supabase && config.supabase.projectRef !== incoming.projectRef) throw new Error('Banco autorizado diverge da configuração do Supabase.')
  const existing = readSetupDatabase(cwd)
  if (existing !== null) {
    developmentDatabase(existing)
    if (existing.projectRef !== incoming.projectRef) throw new Error('O banco existente diverge do autorizado; valores existentes preservados.')
  }
  const linked = optionalSetupFile(cwd, 'supabase/.temp/project-ref')?.trim()
  if (linked && linked !== incoming.projectRef) throw new Error('O link local aponta para outro banco; preparação interrompida.')
  const original = optionalSetupFile(cwd, '.env.local')
  const current = publicValues(cwd, stack)
  const preserved = publicSupabaseEnvironment(stack, parse(original ?? ''))
  const values = publicSupabaseEnvironment(stack, config.env)
  const prefix = stack === 'tanstack-start-vite' ? 'VITE_' : 'NEXT_PUBLIC_'
  const urlName = `${prefix}SUPABASE_URL`
  const expectedUrl = incoming.projectRef === null ? undefined : `https://${incoming.projectRef}.supabase.co`
  if ((values[urlName] && values[urlName] !== expectedUrl) || (preserved[urlName] && preserved[urlName] !== expectedUrl)) {
    throw new Error('O banco público diverge do development autorizado; valores existentes preservados.')
  }
  const additions = Object.entries({ ...values, ...preserved }).filter(([name, value]) => value && !current[name])
  if (original === null || additions.length > 0) {
    // Retain comments, unrelated variables, quoting and nonempty public keys.
    const suffix = additions.map(([name, value]) => `${name}=${value}`).join('\n')
    writeSetupFile(cwd, '.env.local', `${original ?? ''}${original && !original.endsWith('\n') ? '\n' : ''}${suffix}${suffix ? '\n' : ''}`)
  }
  if (existing === null) {
    writeSetupFile(cwd, '.supremo/database.json', `${JSON.stringify(incoming, null, 2)}\n`)
  }
  if (!setupConfigurationComplete(cwd, stack)) throw new Error('A autorização não retornou a configuração pública completa do development.')
  return existing ?? incoming
}
