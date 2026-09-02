import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Armazenamento SEGURO da identidade da máquina (device secret do checkpoint
 * daemon). O secret NUNCA fica no projeto: vai para o keychain do SO —
 *   • macOS:  Keychain via `security`;
 *   • Linux:  libsecret via `secret-tool` (se disponível).
 * Fallback (sem keychain): arquivo 0600 no diretório de config do USUÁRIO
 * (~/.config/supremo), fora de qualquer projeto/Git. Em todos os casos o secret
 * é indexado por projeto, e nunca aparece em argv de leitura, log ou stdout.
 *
 * O `security`/`secret-tool` recebem o secret pela ENV/STDIN, nunca em argv —
 * ver saveSecret. A seleção de comando é PURA (keychainService) e testável.
 */

const SERVICE = 'supremo-checkpoint-daemon'

export function keychainService(): string {
  return SERVICE
}

/** Conta (chave) do secret dentro do serviço: uma por projeto. */
export function accountFor(projectId: string): string {
  return `project:${projectId}`
}

export interface Keychain {
  save(projectId: string, secret: string): void
  get(projectId: string): string | null
  remove(projectId: string): void
}

// ── macOS: `security` ────────────────────────────────────────────────────────

function macSave(account: string, secret: string): void {
  // -w recebe o valor; para não expor em argv, passamos via stdin com -w -.
  // `security` aceita o valor por stdin quando -w não tem argumento.
  execFileSync(
    'security',
    ['add-generic-password', '-a', account, '-s', SERVICE, '-U', '-w'],
    { input: secret, stdio: ['pipe', 'ignore', 'ignore'] },
  )
}
function macGet(account: string): string | null {
  try {
    return execFileSync(
      'security',
      ['find-generic-password', '-a', account, '-s', SERVICE, '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim()
  } catch {
    return null
  }
}
function macRemove(account: string): void {
  try {
    execFileSync(
      'security',
      ['delete-generic-password', '-a', account, '-s', SERVICE],
      { stdio: 'ignore' },
    )
  } catch {
    // já não existe
  }
}

// ── Linux: `secret-tool` (libsecret) ─────────────────────────────────────────

function hasSecretTool(): boolean {
  try {
    execFileSync('secret-tool', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}
function linuxSave(account: string, secret: string): void {
  execFileSync(
    'secret-tool',
    ['store', '--label', SERVICE, 'service', SERVICE, 'account', account],
    { input: secret, stdio: ['pipe', 'ignore', 'ignore'] },
  )
}
function linuxGet(account: string): string | null {
  try {
    return execFileSync(
      'secret-tool',
      ['lookup', 'service', SERVICE, 'account', account],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim()
  } catch {
    return null
  }
}
function linuxRemove(account: string): void {
  try {
    execFileSync(
      'secret-tool',
      ['clear', 'service', SERVICE, 'account', account],
      { stdio: 'ignore' },
    )
  } catch {
    // já não existe
  }
}

// ── Fallback: arquivo 0600 no config do usuário (fora do projeto) ────────────

function fileDir(): string {
  const base =
    process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config')
  return path.join(base, 'supremo', 'checkpoint')
}
function filePath(account: string): string {
  const safe = account.replace(/[^A-Za-z0-9_.-]/g, '_')
  return path.join(fileDir(), `${safe}.secret`)
}
function fileSave(account: string, secret: string): void {
  fs.mkdirSync(fileDir(), { recursive: true, mode: 0o700 })
  fs.writeFileSync(filePath(account), secret, { mode: 0o600 })
}
function fileGet(account: string): string | null {
  try {
    return fs.readFileSync(filePath(account), 'utf8').trim()
  } catch {
    return null
  }
}
function fileRemove(account: string): void {
  try {
    fs.rmSync(filePath(account))
  } catch {
    // já não existe
  }
}

/** Seleciona o backend de keychain do SO atual (macOS > libsecret > arquivo). */
export function resolveKeychain(
  platform: NodeJS.Platform = process.platform,
): Keychain {
  if (platform === 'darwin') {
    return {
      save: (p, s) => macSave(accountFor(p), s),
      get: (p) => macGet(accountFor(p)),
      remove: (p) => macRemove(accountFor(p)),
    }
  }
  if (platform === 'linux' && hasSecretTool()) {
    return {
      save: (p, s) => linuxSave(accountFor(p), s),
      get: (p) => linuxGet(accountFor(p)),
      remove: (p) => linuxRemove(accountFor(p)),
    }
  }
  return {
    save: (p, s) => fileSave(accountFor(p), s),
    get: (p) => fileGet(accountFor(p)),
    remove: (p) => fileRemove(accountFor(p)),
  }
}
