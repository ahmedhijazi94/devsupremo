import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
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

/**
 * Timeout de TODA chamada ao keychain do SO. `execFileSync`'s próprio
 * `timeout` é a ÚNICA coisa capaz de interromper uma syscall bloqueante de
 * verdade — o timeout de um test runner (ou qualquer código JS por cima) NÃO
 * consegue matar um processo filho travado numa chamada síncrona (o worker
 * inteiro fica bloqueado no syscall; nada em JS roda até ele retornar).
 * Sem isto, save/get/remove podiam travar indefinidamente se o daemon do
 * keychain do SO (securityd/gnome-keyring) ficar momentaneamente contendido.
 *
 * LIMITAÇÃO REAL DO macOS (documentada, não escondida — ver relatório):
 * o item é CRIADO via JXA/osascript (macSave) mas LIDO via a CLI `security`
 * (macGet/macRemove) — identidades de processo diferentes. Na PRIMEIRA vez
 * que `security` lê um item recém-criado por outro chamador, o macOS pode
 * levar alguns segundos para resolver a autorização entre eles (medido: até
 * ~19s numa máquina real). TODAS as leituras seguintes do MESMO item (o
 * daemon faz polling do MESMO account o tempo todo) são rápidas (~20-30ms,
 * confirmado empiricamente) — não é uma solicitação repetida, é UMA vez por
 * item. 20s cobre com folga essa primeira leitura sem deixar uma trava real
 * (rede fora do ar, keychain genuinely preso) passar despercebida.
 */
const KEYCHAIN_TIMEOUT_MS = 20_000

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

// ── macOS: grava via JXA/Security.framework (leitura/remoção via `security`) ──
//
// BUG REAL (E2E supremo-cli@1.2.0): `security add-generic-password ... -w`
// SEM valor não lê de stdin — o próprio `security help add-generic-password`
// documenta: "Specify -w as the last option to be prompted." Confirmado
// empiricamente: mesmo com stdin redirecionado, ele abre um prompt
// interativo ("password data for new item:") direto no terminal controlador,
// ignora o que foi passado por pipe, e ainda assim pode retornar sucesso com
// um valor vazio/errado. Não existe modo `-w` não-interativo na CLI oficial.
//
// Fix: chamamos o Security.framework DIRETO via `osascript -l JavaScript`
// (JXA — vem em todo macOS, sem dependência nativa/compilação, preservando o
// bundle único do esbuild). O SCRIPT é ESTÁTICO (nunca contém o segredo —
// gerado uma vez, sem interpolação); conta/serviço/segredo chegam ao
// processo filho SÓ por variável de ambiente (mesmo padrão já usado no
// código para SUPREMO_GIT_TOKEN/SUPABASE_DB_PASSWORD) — nunca em argv, nunca
// no texto do script, nunca em stdout/stderr (stdio totalmente 'ignore').
// As chaves do dicionário de query (class/acct/svce/v_Data) são os valores
// LITERAIS e estáveis que os símbolos kSecClass* resolvem — o bridge do JXA
// não expõe essas constantes C como dado, só como seletor.
//
// Leitura (`find-generic-password -w`) e remoção (`delete-generic-password`)
// continuam pela CLI oficial: confirmado que NENHUMA das duas prompta (o -w
// de LEITURA só controla o que é impresso, semântica diferente do de escrita).

/** Script JXA estático — NUNCA interpola o segredo; lê tudo de env em runtime. */
export function keychainAddScript(): string {
  return `
ObjC.import('Security')
ObjC.import('Foundation')
function cfstr(s) { return $.NSString.alloc.initWithUTF8String(s) }
function env(name) {
  var v = $.NSProcessInfo.processInfo.environment.objectForKey(name)
  return v ? v.js : null
}
var account = env('SUPREMO_KC_ACCOUNT')
var service = env('SUPREMO_KC_SERVICE')
var secret = env('SUPREMO_KC_SECRET')
if (!account || !service || !secret) {
  throw new Error('SUPREMO_KC_ACCOUNT/SERVICE/SECRET ausentes na env do processo.')
}
var delQuery = $.NSMutableDictionary.alloc.init
delQuery.setObjectForKey(cfstr('genp'), cfstr('class'))
delQuery.setObjectForKey(cfstr(account), cfstr('acct'))
delQuery.setObjectForKey(cfstr(service), cfstr('svce'))
$.SecItemDelete(delQuery) // idempotente: -U (substitui se já existir)
var data = cfstr(secret).dataUsingEncoding($.NSUTF8StringEncoding)
var addQuery = $.NSMutableDictionary.alloc.init
addQuery.setObjectForKey(cfstr('genp'), cfstr('class'))
addQuery.setObjectForKey(cfstr(account), cfstr('acct'))
addQuery.setObjectForKey(cfstr(service), cfstr('svce'))
addQuery.setObjectForKey(data, cfstr('v_Data'))
var status = $.SecItemAdd(addQuery, $())
if (status !== 0) { throw new Error('SecItemAdd falhou: status ' + status) }
`.trim()
}

/** Args do osascript — SEM o segredo (ele só existe na env do processo filho). */
export function macSaveArgs(scriptPath: string): { cmd: string; args: string[] } {
  return { cmd: 'osascript', args: ['-l', 'JavaScript', scriptPath] }
}

/** Env do processo filho — único canal por onde o segredo viaja. */
export function macSaveEnv(
  base: NodeJS.ProcessEnv,
  account: string,
  service: string,
  secret: string,
): NodeJS.ProcessEnv {
  return {
    ...base,
    SUPREMO_KC_ACCOUNT: account,
    SUPREMO_KC_SERVICE: service,
    SUPREMO_KC_SECRET: secret,
  }
}

function macSave(account: string, secret: string): void {
  const scriptPath = path.join(
    os.tmpdir(),
    `supremo-kc-${crypto.randomBytes(8).toString('hex')}.js`,
  )
  // Script ESTÁTICO (sem segredo) — mode 0600 desde a criação.
  fs.writeFileSync(scriptPath, keychainAddScript(), { mode: 0o600 })
  try {
    const { cmd, args } = macSaveArgs(scriptPath)
    execFileSync(cmd, args, {
      env: macSaveEnv(process.env, account, SERVICE, secret),
      // Nem o osascript nem o script imprimem o segredo (o script só lança um
      // status NUMÉRICO em erro) — stdout/stderr vão para PIPE (capturados,
      // nunca impressos no terminal do usuário) em vez de 'ignore'. IMPORTANTE:
      // com os 3 fds em 'ignore' ao mesmo tempo, confirmado empiricamente que
      // o osascript TRAVA indefinidamente neste processo (mesmo sem prompt
      // nenhum) — stdin pode ficar 'ignore' (não usamos), mas stdout/stderr
      // precisam ser 'pipe' (não 'ignore') para o processo terminar.
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: KEYCHAIN_TIMEOUT_MS,
    })
  } finally {
    // Conteúdo do arquivo nunca teve o segredo, mas removemos de qualquer forma.
    try {
      fs.unlinkSync(scriptPath)
    } catch {
      // já não existe
    }
  }
}
function macGet(account: string): string | null {
  try {
    return execFileSync(
      'security',
      ['find-generic-password', '-a', account, '-s', SERVICE, '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: KEYCHAIN_TIMEOUT_MS },
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
      { stdio: 'ignore', timeout: KEYCHAIN_TIMEOUT_MS },
    )
  } catch {
    // já não existe
  }
}

// ── Linux: `secret-tool` (libsecret) ─────────────────────────────────────────

function hasSecretTool(): boolean {
  try {
    execFileSync('secret-tool', ['--version'], { stdio: 'ignore', timeout: KEYCHAIN_TIMEOUT_MS })
    return true
  } catch {
    return false
  }
}
function linuxSave(account: string, secret: string): void {
  execFileSync(
    'secret-tool',
    ['store', '--label', SERVICE, 'service', SERVICE, 'account', account],
    { input: secret, stdio: ['pipe', 'ignore', 'ignore'], timeout: KEYCHAIN_TIMEOUT_MS },
  )
}
function linuxGet(account: string): string | null {
  try {
    return execFileSync(
      'secret-tool',
      ['lookup', 'service', SERVICE, 'account', account],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: KEYCHAIN_TIMEOUT_MS },
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
      { stdio: 'ignore', timeout: KEYCHAIN_TIMEOUT_MS },
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
