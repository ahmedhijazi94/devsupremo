import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Armazenamento SEGURO da identidade da máquina (device secret do checkpoint
 * daemon). O secret NUNCA fica no projeto: vai para o keychain do SO —
 *   • macOS:  Keychain via Security.framework (JXA/osascript — ver abaixo);
 *   • Linux:  libsecret via `secret-tool` (se disponível).
 * Fallback (sem keychain): arquivo 0600 no diretório de config do USUÁRIO
 * (~/.config/supremo), fora de qualquer projeto/Git. Em todos os casos o secret
 * é indexado por projeto, e nunca aparece em argv de leitura ou em log/stderr.
 *
 * TRANSPORTE do valor lido no macOS (get): o script JXA escreve o segredo no
 * stdout do PRÓPRIO processo `osascript` (fd 1) via NSFileHandle — mas esse
 * fd é um PIPE interno (`stdio: ['ignore','pipe','pipe']`, nunca 'inherit'),
 * não o terminal nem o stdout do processo Node. `execFileSync` (com
 * `encoding: 'utf8'`) lê esse pipe, decodifica e RETORNA a string —
 * synchronamente, só na memória do processo Node — como valor de retorno de
 * `runKeychainScript`/`macGet`. Esse valor nunca é passado para
 * `console.*`/`process.stdout.write`/`process.stderr.write` (este arquivo não
 * chama nenhum dos dois) — os chamadores (bootstrap.ts, daemon.ts, bin.ts) só
 * o comparam ou o enviam como campo de request ao backend, nunca o imprimem.
 */

const SERVICE = 'supremo-checkpoint-daemon'

/**
 * Timeout de TODA chamada ao keychain do SO. `execFileSync`'s próprio
 * `timeout` é a ÚNICA coisa capaz de interromper uma syscall bloqueante de
 * verdade — o timeout de um test runner (ou qualquer código JS por cima) NÃO
 * consegue matar um processo filho travado numa chamada síncrona.
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

// ── macOS: Security.framework via JXA, para save/get/remove — MESMA identidade ──
//
// HISTÓRICO DO BUG (2 rodadas de E2E real):
//
// 1ª causa: `security add-generic-password ... -w` SEM valor não lê de
//   stdin — o próprio `security help add-generic-password` documenta:
//   "Specify -w as the last option to be prompted." Não existe modo `-w`
//   não-interativo na CLI oficial. Fix da rodada anterior: gravar via
//   Security.framework direto (SecItemAdd, JXA/osascript).
//
// 2ª causa (a que ESTA rodada corrige): aquele fix deixou save() via JXA MAS
//   get()/remove() continuavam via a CLI `security`. São DUAS IDENTIDADES DE
//   PROCESSO diferentes pedindo acesso ao MESMO item — cada combinação
//   NOVA(criador, leitor) sofre resolução de autorização do macOS, e o E2E
//   real mostrou que isso NÃO fica resolvido de vez: voltou a prompt
//   repetido durante o polling do daemon (a hipótese anterior de "só na
//   primeira vez" foi refutada pelo uso real).
//
// FIX: save/get/remove usam a MESMA identidade de processo (osascript
// rodando JXA) para as TRÊS operações — nenhuma mistura com `security`.
// Confirmado empiricamente (ver relatório): com uma ÚNICA identidade
// consistente, 10 leituras seguidas do mesmo item ficam em ~80-100ms cada,
// SEM nenhum prompt. `security` (CLI) não é mais chamado NENHUMA vez neste
// arquivo para o backend do macOS.
//
// Cada script é ESTÁTICO (nunca contém o segredo — gerado uma vez, sem
// interpolação); conta/serviço/segredo chegam ao processo filho SÓ por
// variável de ambiente (mesmo padrão já usado para SUPREMO_GIT_TOKEN/
// SUPABASE_DB_PASSWORD) — nunca em argv, nunca no texto do script, nunca em
// stdout/stderr além do valor lido explicitamente por getScript. As chaves
// do dicionário de query (class/acct/svce/v_Data/r_Data) são os valores
// LITERAIS e estáveis que os símbolos kSecClass* resolvem — o bridge
// automático do JXA não expõe essas constantes C como dado, só como
// seletor; por isso os literais, não uma ACL customizada.

const JXA_HELPERS = `
function cfstr(s) { return $.NSString.alloc.initWithUTF8String(s) }
function env(name) {
  var v = $.NSProcessInfo.processInfo.environment.objectForKey(name)
  return v ? v.js : null
}
function baseQuery(account, service) {
  var q = $.NSMutableDictionary.alloc.init
  q.setObjectForKey(cfstr('genp'), cfstr('class'))
  q.setObjectForKey(cfstr(account), cfstr('acct'))
  q.setObjectForKey(cfstr(service), cfstr('svce'))
  return q
}
`.trim()

/** Script JXA estático — cria/substitui o item. NUNCA interpola o segredo. */
export function keychainAddScript(): string {
  return `
ObjC.import('Security')
ObjC.import('Foundation')
${JXA_HELPERS}
var account = env('SUPREMO_KC_ACCOUNT')
var service = env('SUPREMO_KC_SERVICE')
var secret = env('SUPREMO_KC_SECRET')
if (!account || !service || !secret) {
  throw new Error('SUPREMO_KC_ACCOUNT/SERVICE/SECRET ausentes na env do processo.')
}
$.SecItemDelete(baseQuery(account, service)) // idempotente: substitui se já existir
var data = cfstr(secret).dataUsingEncoding($.NSUTF8StringEncoding)
var addQuery = baseQuery(account, service)
addQuery.setObjectForKey(data, cfstr('v_Data'))
var status = $.SecItemAdd(addQuery, $())
if (status !== 0) { throw new Error('SecItemAdd falhou: status ' + status) }
`.trim()
}

/**
 * Script JXA estático — lê o item e escreve SÓ o valor no stdout do processo
 * `osascript` (nada mais é escrito lá; erro vai por `throw`, não por print).
 * Esse stdout é um PIPE interno (ver `runKeychainScript`: `stdio:
 * ['ignore','pipe','pipe']`, nunca `'inherit'`) — não é o terminal do
 * usuário nem o stdout do processo Node; `execFileSync` só o lê, decodifica
 * e devolve como string (em memória), e nada neste arquivo chama
 * `console.*`/`process.std{out,err}.write` com esse valor.
 * `SecItemCopyMatching` precisa de `ObjC.bindFunction` com a assinatura C
 * explícita: o bridge AUTOMÁTICO do JXA não entende o parâmetro de saída
 * (CFTypeRef*) e devolve lixo — confirmado empiricamente (ver relatório).
 * Item ausente: sem saída nenhuma, sai limpo (status 0) — `macGet` trata
 * "sem saída" como null, igual ao contrato anterior.
 */
export function keychainGetScript(): string {
  return `
ObjC.import('Security')
ObjC.import('Foundation')
ObjC.bindFunction('SecItemCopyMatching', ['i', ['@', '^@']])
${JXA_HELPERS}
var account = env('SUPREMO_KC_ACCOUNT')
var service = env('SUPREMO_KC_SERVICE')
if (!account || !service) {
  throw new Error('SUPREMO_KC_ACCOUNT/SERVICE ausentes na env do processo.')
}
var query = baseQuery(account, service)
query.setObjectForKey($.NSNumber.numberWithBool(true), cfstr('r_Data'))
var result = Ref()
var status = $.SecItemCopyMatching(query, result)
if (status === 0) {
  var str = $.NSString.alloc.initWithDataEncoding(result[0], $.NSUTF8StringEncoding)
  $.NSFileHandle.fileHandleWithStandardOutput.writeData(str.dataUsingEncoding($.NSUTF8StringEncoding))
} else if (status === -25300) {
  // errSecItemNotFound: sem saída — macGet devolve null
} else {
  throw new Error('SecItemCopyMatching falhou: status ' + status)
}
`.trim()
}

/** Script JXA estático — remove o item (idempotente; não existir não é erro). */
export function keychainRemoveScript(): string {
  return `
ObjC.import('Security')
ObjC.import('Foundation')
${JXA_HELPERS}
var account = env('SUPREMO_KC_ACCOUNT')
var service = env('SUPREMO_KC_SERVICE')
if (!account || !service) {
  throw new Error('SUPREMO_KC_ACCOUNT/SERVICE ausentes na env do processo.')
}
$.SecItemDelete(baseQuery(account, service))
`.trim()
}

/** Args do osascript — SEM o segredo (ele só existe na env do processo filho). */
export function osascriptArgs(scriptPath: string): { cmd: string; args: string[] } {
  return { cmd: 'osascript', args: ['-l', 'JavaScript', scriptPath] }
}

/** Env do processo filho — único canal por onde conta/serviço/segredo viajam. */
export function keychainScriptEnv(
  base: NodeJS.ProcessEnv,
  fields: { account: string; service: string; secret?: string },
): NodeJS.ProcessEnv {
  return {
    ...base,
    SUPREMO_KC_ACCOUNT: fields.account,
    SUPREMO_KC_SERVICE: fields.service,
    ...(fields.secret !== undefined ? { SUPREMO_KC_SECRET: fields.secret } : {}),
  }
}

/**
 * Roda um dos scripts JXA acima: escreve num arquivo temporário 0600 (nunca
 * contém o segredo — só o script ESTÁTICO), executa via osascript com o
 * segredo só na ENV, e sempre limpa o arquivo depois. `stdio: ['ignore',
 * 'pipe', 'pipe']` — confirmado empiricamente que os 3 fds em 'ignore' ao
 * mesmo tempo faz o osascript TRAVAR indefinidamente (sem prompt nenhum);
 * stdout é capturado (não ecoado) para os scripts que retornam valor (get).
 */
function runKeychainScript(
  script: string,
  env: NodeJS.ProcessEnv,
): string {
  const scriptPath = path.join(
    os.tmpdir(),
    `supremo-kc-${crypto.randomBytes(8).toString('hex')}.js`,
  )
  fs.writeFileSync(scriptPath, script, { mode: 0o600 })
  try {
    const { cmd, args } = osascriptArgs(scriptPath)
    return execFileSync(cmd, args, {
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: KEYCHAIN_TIMEOUT_MS,
    })
  } finally {
    try {
      fs.unlinkSync(scriptPath)
    } catch {
      // já não existe
    }
  }
}

function macSave(account: string, secret: string): void {
  runKeychainScript(
    keychainAddScript(),
    keychainScriptEnv(process.env, { account, service: SERVICE, secret }),
  )
}
function macGet(account: string): string | null {
  try {
    const out = runKeychainScript(
      keychainGetScript(),
      keychainScriptEnv(process.env, { account, service: SERVICE }),
    )
    return out.length > 0 ? out : null
  } catch {
    return null
  }
}
function macRemove(account: string): void {
  try {
    runKeychainScript(
      keychainRemoveScript(),
      keychainScriptEnv(process.env, { account, service: SERVICE }),
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
