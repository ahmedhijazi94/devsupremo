import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

/**
 * Config do companion. Vem de env (CI/avançado) ou de ~/.supremo/companion.json
 * (login normal). O token é ESCOPADO do usuário (sup_…), nunca de admin —
 * o companion troca ele por uma SESSÃO dedicada de dispositivo pelo Supremo.
 */

export interface CompanionConfig {
  /** Base do Supremo, ex.: https://supremo-three.vercel.app */
  supremoUrl: string
  /** Token pessoal do usuário (sup_…). */
  token: string
  /** Onde os workspaces isolados dos projetos vivem. */
  workspaceBase: string
  /** Chave estável deste dispositivo — identidade própria do companion. */
  deviceKey: string
}

export function configPath(): string {
  return join(homedir(), '.supremo', 'companion.json')
}

function defaultWorkspaceBase(): string {
  return join(homedir(), '.supremo', 'workspaces')
}

/** Lê a config, priorizando env sobre o arquivo. Lança se faltar o essencial. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): CompanionConfig {
  const fileCfg = readConfigFile()

  const supremoUrl = env.SUPREMO_URL ?? fileCfg?.supremoUrl
  const token = env.SUPREMO_TOKEN ?? fileCfg?.token
  const workspaceBase =
    env.SUPREMO_WORKSPACE_BASE ?? fileCfg?.workspaceBase ?? defaultWorkspaceBase()

  if (!supremoUrl) {
    throw new Error(
      'SUPREMO_URL não definido. Rode "supremo-runtime login" ou defina a env.',
    )
  }
  if (!token) {
    throw new Error(
      'SUPREMO_TOKEN não definido. Rode "supremo-runtime login" ou defina a env.',
    )
  }

  return {
    supremoUrl: supremoUrl.replace(/\/$/, ''),
    token,
    workspaceBase,
    deviceKey: env.SUPREMO_DEVICE_KEY ?? ensureDeviceKey(fileCfg?.deviceKey),
  }
}

/** Chave estável do dispositivo: reusa a salva, ou cria e persiste uma vez. */
function ensureDeviceKey(existing: string | undefined): string {
  if (existing) return existing
  const deviceKey = randomUUID()
  const path = configPath()
  try {
    const current = existsSync(path)
      ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>)
      : {}
    mkdirSync(join(homedir(), '.supremo'), { recursive: true })
    writeFileSync(path, JSON.stringify({ ...current, deviceKey }, null, 2))
  } catch {
    // sem disco: usa em memória nesta execução (identidade nova no próximo run)
  }
  return deviceKey
}

function readConfigFile(): Partial<CompanionConfig> | null {
  const path = configPath()
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Partial<CompanionConfig>
  } catch {
    return null
  }
}
