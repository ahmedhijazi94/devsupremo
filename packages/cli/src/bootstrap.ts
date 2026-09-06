import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { defaultAuthIO, ensureAuthorized, openBrowser } from './auth'
import { validationWorkerHealthy } from './turn-validation'
import { preCommitHook, prePushHook } from './git-hooks'
import { inspectHostAdapters, type IntegrationMode } from './host-adapters'

/**
 * `supremo bootstrap <project-id>` — device flow + workspace local pronto.
 *
 * O comando carrega só o project-id (não é segredo). O CLI inicia um device
 * flow, o dono autoriza no browser, e só então o CLI recebe a config. O token
 * de git é usado só no clone e NUNCA aparece em URL, argv, .git/config,
 * stdout/stderr ou log: vai por variável de ambiente lida por um credential
 * helper efêmero, sobre a URL limpa do repo.
 */

export interface BootstrapConfig {
  database?: { environment: string; projectRef: string | null; automaticMigrations: boolean }
  project: {
    id: string
    name: string
    capabilities: string[]
    scaffoldVersion: string | null
    securityProfile: string | null
  }
  repo: { url: string; fullName: string; branch: string }
  gitToken: string
  gitTokenScope: 'installation' | 'user'
  env: Record<string, string>
  /**
   * Presente quando o projeto tem Supabase. Usado para `supabase link`. A
   * `dbPassword` (quando vem) é injetada só na env do processo do link e gravada
   * pela CLI oficial no keychain do SO — nunca em .env.local/Git/argv/log/stdout.
   */
  supabase?: {
    projectRef: string
    dbPassword?: string
    /** Major do Postgres do projeto remoto, para alinhar o supabase/config.toml. */
    majorVersion?: number
  }
  /**
   * Identidade da MÁQUINA para o checkpoint daemon (v3.1). O `deviceSecret` chega
   * SÓ por este canal e é gravado no keychain do SO — nunca em .env.local, Git,
   * argv, log ou stdout. O banco guarda só o hash.
   */
  daemon?: { deviceId: string; deviceSecret: string }
}

// ── Helpers puros (testáveis) ───────────────────────────────────────────────

export function buildEnvFile(env: Record<string, string>): string {
  return (
    Object.entries(env)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n') + '\n'
  )
}

/**
 * Diretório-alvo do clone. Por padrão, a PASTA ATUAL (o dev roda o comando dentro
 * da pasta onde guarda os projetos) + o nome do repo — criado automaticamente, sem
 * precisar criar a pasta antes. `--dir` sobrescreve a base.
 */
export function targetDir(repoFullName: string, baseDir?: string): string {
  const name = repoFullName.split('/').pop() || 'projeto'
  return path.join(baseDir ?? process.cwd(), name)
}

export function cleanRemoteUrl(repoFullName: string): string {
  return `https://github.com/${repoFullName}.git`
}

/**
 * Args do `git clone` SEM o token: a URL é limpa e o token chega por um
 * credential helper efêmero que lê a env SUPREMO_GIT_TOKEN. O primeiro
 * `credential.helper=` zera helpers do sistema (só o nosso responde).
 */
export function gitCloneArgs(
  repoFullName: string,
  branch: string,
  dest: string,
): string[] {
  const helper =
    "!f() { test \"$1\" = get && printf 'username=x-access-token\\npassword=%s\\n' \"$SUPREMO_GIT_TOKEN\"; }; f"
  return [
    '-c',
    'credential.helper=',
    '-c',
    `credential.helper=${helper}`,
    'clone',
    '--branch',
    branch,
    cleanRemoteUrl(repoFullName),
    dest,
  ]
}

/**
 * Args do `supabase link` — SEM a senha. A senha do banco jamais entra em argv
 * (visível em `ps`): ela vai só pela env do processo (ver supabaseLinkEnv), que
 * a CLI oficial lê e grava no keychain do SO.
 */
export function supabaseLinkArgs(projectRef: string): string[] {
  return ['link', '--project-ref', projectRef]
}

/**
 * Env do processo do `supabase link`: injeta SUPABASE_DB_PASSWORD só quando há
 * senha, para o link ser não-interativo e a CLI persistir a senha no keychain.
 * A senha nunca é logada nem escrita em arquivo por nós.
 */
export function supabaseLinkEnv(
  base: NodeJS.ProcessEnv,
  dbPassword?: string,
): NodeJS.ProcessEnv {
  return dbPassword ? { ...base, SUPABASE_DB_PASSWORD: dbPassword } : { ...base }
}

/**
 * A conta logada no CLI tem acesso a este projeto? `supabase projects list`
 * imprime uma linha por projeto com o REFERENCE ID; se o ref aparece, a conta é
 * dona/membro. Usado para detectar divergência de conta (o Supremo pode ter
 * criado o projeto numa conta Supabase diferente da que está logada no CLI) sem
 * jamais enviar o token do backend para a máquina.
 */
export function projectListHasRef(
  projectsListOutput: string,
  projectRef: string,
): boolean {
  return projectsListOutput.includes(projectRef)
}

/**
 * Ajusta `major_version` no supabase/config.toml para casar com o Postgres do
 * projeto remoto, evitando o aviso "Local database version differs". Só mexe na
 * linha do bloco [db]; se não achar, devolve o conteúdo intacto.
 */
export function patchConfigMajorVersion(
  configToml: string,
  major: number,
): string {
  return configToml.replace(
    /^(\s*major_version\s*=\s*)\d+/m,
    `$1${major}`,
  )
}

/**
 * `supabase db push --dry-run` diz que o histórico está sincronizado? Verdadeiro
 * quando a CLI reporta "up to date" ou não lista nenhuma migration pendente
 * (nome com timestamp de 14 dígitos). Usado só para reportar o estado; nunca
 * dispara mutação.
 */
export function migrationDryRunSynced(dryRunOutput: string): boolean {
  if (/up to date|no schema changes|nothing to push/i.test(dryRunOutput)) {
    return true
  }
  // Se não menciona nenhuma migration com timestamp, não há nada pendente.
  return !/\b\d{14}_/.test(dryRunOutput)
}

// ── Orquestração ────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface StartResponse {
  deviceCode: string
  userCode: string
  verificationUri: string
  verificationUriComplete: string
  expiresAt: string
  intervalSec: number
}


async function startDeviceFlow(
  baseUrl: string,
  projectId: string,
): Promise<StartResponse> {
  const res = await fetch(`${baseUrl}/api/bootstrap/device/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId }),
  })
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(data.error ?? `Não iniciou o bootstrap (${res.status}).`)
  }
  return (await res.json()) as StartResponse
}

async function pollForConfig(
  baseUrl: string,
  deviceCode: string,
  intervalSec: number,
  expiresAt: string,
): Promise<BootstrapConfig> {
  const deadline = Date.parse(expiresAt)
  while (Date.now() < deadline) {
    await sleep(intervalSec * 1000)
    const res = await fetch(`${baseUrl}/api/bootstrap/device/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceCode }),
    })
    const data = (await res.json().catch(() => ({}))) as {
      status?: string
      config?: BootstrapConfig
      error?: string
    }
    if (data.status === 'ready' && data.config) return data.config
    if (data.status === 'pending') continue
    if (data.status === 'expired') throw new Error('Autorização expirou.')
    if (data.status === 'denied') throw new Error('Autorização negada.')
    if (data.status === 'error') throw new Error(data.error ?? 'Falha no bootstrap.')
    // 'gone' ou desconhecido
    throw new Error('Autorização inválida. Rode o comando de novo.')
  }
  throw new Error('Tempo de autorização esgotado.')
}

const run = (cmd: string, args: string[], cwd?: string, env?: NodeJS.ProcessEnv) =>
  execFileSync(cmd, args, { cwd, env, stdio: 'inherit' })

const ok = (label: string) => console.log(`✓ ${label}`)

/** Roda um comando silenciosamente e diz se saiu 0 (para detecção, sem poluir). */
const tryExec = (cmd: string, args: string[]): boolean => {
  try {
    execFileSync(cmd, args, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** Roda um comando e devolve o stdout, ou null se falhou. stderr é silenciado. */
const tryExecOut = (cmd: string, args: string[]): string | null => {
  try {
    return execFileSync(cmd, args, {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    })
  } catch {
    return null
  }
}

/** Como `tryExecOut`, mas rodando dentro de `cwd` (para checar o projeto gerado). */
const tryExecOutIn = (cmd: string, args: string[], cwd: string): string | null => {
  try {
    return execFileSync(cmd, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    })
  } catch {
    return null
  }
}

// ── Readiness LOCAL (v3.1 finalização) ───────────────────────────────────────
//
// Um E2E real revelou o bootstrap dizendo "pronto" enquanto o primeiro
// checkpoint falhava: os scripts npm gerados chamam `npx --yes supremo-cli ...`,
// que resolve a versão PUBLICADA no registry — se ela estiver desatualizada
// (código novo só em git, ainda não publicado), os comandos de checkpoint/daemon
// simplesmente não existem nela. `daemonCliOutputLooksValid` roda EXATAMENTE o
// que `npm run daemon:status` rodaria e confere a forma da saída — pega esse
// gap ANTES de declarar o projeto pronto, em vez de o usuário descobrir no
// primeiro checkpoint.

/**
 * PURA: a saída de `daemon --status` tem a forma esperada (CLI compatível)?
 * O formato é JSON machine-readable ({"running":bool,...}) — uma CLI publicada
 * desatualizada cai na ponte MCP (texto de erro) ou recusa a opção, e nenhum
 * dos dois faz JSON.parse virar um objeto com "running" booleano.
 */
export function daemonCliOutputLooksValid(output: string | null): boolean {
  if (output === null) return false
  try {
    const parsed: unknown = JSON.parse(output)
    return (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as { running?: unknown }).running === 'boolean'
    )
  } catch {
    return false
  }
}

export interface LocalReadiness {
  ok: boolean
  state: 'ready' | 'degraded' | 'not_ready'
  integrationMode: IntegrationMode
  issues: string[]
}

/**
 * PURA: a saída de `preview:status` tem a forma esperada E reporta saudável?
 * (mesmo espírito de `daemonCliOutputLooksValid` — JSON machine-readable, ver
 * `previewSupervisorScript()` no gerador do template.)
 */
export function previewStatusHealthy(output: string | null): boolean {
  if (output === null) return false
  try {
    const parsed = JSON.parse(output) as { running?: unknown; healthy?: unknown }
    return parsed.running === true && parsed.healthy === true
  } catch {
    return false
  }
}

export function previewStatusUrl(output: string | null): string | null {
  if (!previewStatusHealthy(output) || output === null) return null
  try {
    const parsed: unknown = JSON.parse(output)
    if (typeof parsed !== 'object' || parsed === null || !('url' in parsed) || typeof parsed.url !== 'string') return null
    const url = new URL(parsed.url)
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      ? url.href.replace(/\/$/, '') : null
  } catch { return null }
}

/**
 * PURA: decide se o workflow local prometido está de fato operacional.
 * "Ready" só é verdade quando device identity, daemon E preview estão de pé —
 * nunca porque os PASSOS rodaram sem lançar exceção (foi exatamente essa
 * folga que deixou o bootstrap declarar pronto com daemon/preview mortos).
 */
export function validateLocalReadiness(input: {
  projectJsonOk: boolean
  hasDaemonIdentity: boolean
  daemonRunning: boolean
  npmScriptsCompatible: boolean | null // null = não aplicável (sem identidade de daemon)
  previewHealthy: boolean
  setupSucceeded: boolean
  gitHooksVerified: boolean
  lifecycleVerified: boolean
  validationWorkerAvailable: boolean
  databaseEnvironmentReady: boolean
  integrationMode: IntegrationMode
}): LocalReadiness {
  const issues: string[] = []
  if (!input.projectJsonOk) issues.push('.supremo/project.json ausente/incompleto')
  if (!input.hasDaemonIdentity) issues.push('identidade do checkpoint daemon ausente')
  if (input.hasDaemonIdentity) {
    if (!input.daemonRunning) issues.push('checkpoint daemon não subiu')
    if (input.npmScriptsCompatible !== true) {
      issues.push(
        'os scripts npm gerados (checkpoint/daemon) não batem com a CLI resolvida ' +
        'localmente — CLI desatualizada/incompatível',
      )
    }
  }
  if (!input.previewHealthy) issues.push('preview não subiu saudável')
  if (!input.setupSucceeded) issues.push('setup:local falhou; baseline/instalação incompleto')
  if (!input.gitHooksVerified) issues.push('git hooks ausentes ou não ativados')
  if (!input.lifecycleVerified) issues.push('turn lifecycle adapter ausente/incompatível')
  if (!input.validationWorkerAvailable) issues.push('worker local de validação indisponível')
  if (!input.databaseEnvironmentReady) issues.push('ambiente de banco não autorizado para development')
  if (input.integrationMode === 'unsupported') issues.push('host sem integração utilizável')
  const critical = issues.length > 0
  if (input.integrationMode === 'assisted') issues.push('host assisted: início/fim de turno dependem do agente; sem garantia de hooks')
  const state = critical ? 'not_ready' : input.integrationMode === 'enforced' ? 'ready' : 'degraded'
  return { ok: state === 'ready', state, integrationMode: input.integrationMode, issues }
}

export function projectIdentityValid(source: string | null, expectedId: string): boolean {
  if (!source) return false
  try {
    const value: unknown = JSON.parse(source)
    if (typeof value !== 'object' || value === null) return false
    const item = value as { projectId?: unknown; supremoUrl?: unknown }
    return item.projectId === expectedId && typeof item.supremoUrl === 'string' &&
      (new URL(item.supremoUrl).protocol === 'https:' ||
        (new URL(item.supremoUrl).protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(item.supremoUrl).hostname)))
  } catch { return false }
}

export function gitHooksVerified(root: string): boolean {
  if (tryExecOutIn('git', ['config', '--get', 'core.hooksPath'], root)?.trim() !== '.githooks') return false
  try {
    for (const [name, expected] of [['pre-commit', preCommitHook], ['pre-push', prePushHook]] as const) {
      const file = path.join(root, '.githooks', name)
      fs.accessSync(file, fs.constants.R_OK | fs.constants.X_OK)
      if (fs.readFileSync(file, 'utf8') !== expected) return false
    }
    return true
  } catch { return false }
}

/** Roda o mesmo comando que `npm run daemon:status` rodaria, no projeto gerado. */
function checkNpmScriptsCompatible(dest: string): boolean {
  return daemonCliOutputLooksValid(
    tryExecOutIn(process.execPath, [path.join(dest, 'node_modules/supremo-cli/dist/bin.js'), 'daemon', '--status'], dest),
  )
}

// ── Node runtime (v3.1 finalização, seção 8) ─────────────────────────────────
//
// E2E real: Node 23 (release "Current", não-LTS) fez `npm ci` do projeto
// gerado avisar (EBADENGINE) que `eslint-visitor-keys` só suporta
// "^20.19.0 || ^22.13.0 || >=24" — Node 23 cai fora de TODAS essas faixas.
// Confirmado NÃO-BLOQUEANTE (npm segue instalando; é warning, não erro) — por
// isso o tratamento aqui é AVISO CLARO + recomendação de Node 22 LTS, não
// fail-fast: não há evidência de risco real de falha, só de incompatibilidade
// pontual de engines em devDependencies. Se isso mudar (uma versão realmente
// quebrar o build), o fail-fast vira justificado — não hoje.

export const RECOMMENDED_NODE_MAJORS = [20, 22, 24] as const // linhas LTS

export type NodeVersionCheck =
  | { status: 'ok'; major: number }
  | { status: 'warn'; major: number; message: string }

/** PURA: Node fora das linhas LTS testadas → aviso claro (nunca bloqueia). */
export function checkNodeVersion(nodeVersion: string): NodeVersionCheck {
  const major = Number(nodeVersion.replace(/^v/, '').split('.')[0])
  if ((RECOMMENDED_NODE_MAJORS as readonly number[]).includes(major)) {
    return { status: 'ok', major }
  }
  return {
    status: 'warn',
    major,
    message:
      `Node ${nodeVersion} não é uma versão LTS testada pelo Supremo (recomendado: ` +
      `Node 22 LTS). Isto NÃO deveria travar a instalação, mas algumas dependências ` +
      `podem avisar incompatibilidade (EBADENGINE) — se algo estranho acontecer, ` +
      `troque para Node 22 LTS e rode o bootstrap de novo.`,
  }
}

/** Roda o mesmo comando que `npm run preview:status` rodaria, no projeto gerado. */
function checkPreviewHealthy(dest: string): boolean {
  return previewStatusHealthy(tryExecOutIn('node', ['scripts/preview.mjs', 'status'], dest))
}

/**
 * Deixa o checkout pronto para o agente (Claude/Codex) operar o Supabase ONLINE
 * de forma AUTOMÁTICA, sem MCP e sem comando manual:
 *
 *   • garante a CONTA CERTA — reaproveita o `supabase login` se já for a dona do
 *     projeto; se não estiver logado OU estiver na conta errada, conduz o login
 *     oficial no browser (você só autoriza), trocando de conta;
 *   • alinha `major_version` do supabase/config.toml à versão real do Postgres;
 *   • `supabase link --project-ref <ref>` (senha só na env do processo → keychain;
 *     nunca em .env.local/Git/argv/log/stdout) e VALIDA `supabase/.temp/project-ref`
 *     antes de considerar pronto (se divergir, para antes de qualquer mutação);
 *   • NUNCA usa o token OAuth do backend do Supremo — a credencial local é a do
 *     `supabase login` do dev, gerida pela CLI oficial no keychain do SO.
 *
 * Retorna true só quando o checkout ficou linkado e validado. Falha aqui não
 * quebra o bootstrap (o app local já está pronto); sempre imprime o passo manual.
 */
async function linkSupabaseRemote(
  dest: string,
  supabase: { projectRef: string; dbPassword?: string; majorVersion?: number },
): Promise<boolean> {
  const { projectRef, dbPassword, majorVersion } = supabase
  // CLI LOCAL PINADA do projeto (node_modules/.bin/supabase) — nunca a global.
  // Assim a versão é a mesma em qualquer máquina/agente.
  const { bin: sb, local } = resolveSupabaseBin(dest)
  const manual = `cd ${dest} && npx supabase link --project-ref ${projectRef}`

  const version = tryExecOut(sb, ['--version'])
  if (version === null) {
    console.log(
      `\n• Supabase CLI não disponível — pulei o link do banco online.\n` +
        `  A CLI é uma devDependency pinada; garanta o "npm ci" e rode:\n    ${manual}\n`,
    )
    return false
  }
  ok(`Supabase CLI disponível (${local ? 'local pinada' : 'global'} v${version.trim()})`)

  // Autorização do Supabase pelo MESMO padrão único (Auth Orchestrator): detecta
  // se já está logado; se não, ENTER → `supabase login` (abre o browser oficial e
  // aguarda) → detecta. Nunca inventamos auth própria nem enviamos o token do backend.
  const supabaseOk = await ensureAuthorized({
    name: 'Supabase',
    prompt: 'Supabase precisa ser autorizado nesta máquina. Pressione ENTER para continuar…',
    isAuthorized: () => tryExecOut(sb, ['projects', 'list']) !== null,
    authorize: () => {
      try {
        run(sb, ['login'], dest)
      } catch {
        // o re-check do isAuthorized decide o sucesso
      }
    },
  })
  if (!supabaseOk) {
    console.log(`• Login do Supabase não concluído — pulei o link.\n    ${manual}\n`)
    return false
  }

  // Conta correta (dona do projeto). Se for a errada, troca de conta pelo mesmo
  // padrão (ENTER → login na conta certa), sem pedir comando manual.
  let projects = tryExecOut(sb, ['projects', 'list']) ?? ''
  if (!projectListHasRef(projects, projectRef)) {
    await defaultAuthIO.waitForEnter(
      'A conta Supabase logada não é a dona deste projeto. Pressione ENTER para entrar na conta certa…',
    )
    tryExec(sb, ['logout'])
    try {
      run(sb, ['login'], dest)
    } catch {
      // re-check abaixo
    }
    projects = tryExecOut(sb, ['projects', 'list']) ?? ''
    if (!projectListHasRef(projects, projectRef)) {
      console.log(
        `\n• A conta logada ainda não é a dona do projeto ${projectRef}.\n` +
          `  Entre com a MESMA conta Supabase que você conectou ao Supremo:\n` +
          `    npx supabase login && ( ${manual} )\n`,
      )
      return false
    }
  }
  ok('Conta correta')

  // Alinha a versão do Postgres no config.toml (evita "Local database version differs").
  if (majorVersion) {
    try {
      const cfgPath = path.join(dest, 'supabase', 'config.toml')
      const cfg = fs.readFileSync(cfgPath, 'utf8')
      const patched = patchConfigMajorVersion(cfg, majorVersion)
      if (patched !== cfg) fs.writeFileSync(cfgPath, patched)
      ok('PostgreSQL/config alinhados')
    } catch {
      // sem config.toml legível: segue (o link ainda funciona)
    }
  }

  // Link: senha só na env (nunca em argv); ref grava em supabase/.temp.
  try {
    execFileSync(sb, supabaseLinkArgs(projectRef), {
      cwd: dest,
      env: supabaseLinkEnv(process.env, dbPassword),
      stdio: ['ignore', 'ignore', 'inherit'],
    })
  } catch {
    console.log(`• Não consegui linkar automaticamente. Rode:\n    ${manual}\n`)
    return false
  }

  // Valida o ref linkado ANTES de considerar pronto — nada de projeto errado.
  const linkedRef = readLinkedRef(dest)
  if (linkedRef !== projectRef) {
    console.log(
      `\n• Divergência no link: esperado ${projectRef}, mas ` +
        `supabase/.temp/project-ref = ${linkedRef ?? '(vazio)'}. Parei antes de ` +
        `qualquer operação no banco.\n`,
    )
    return false
  }
  ok(`Projeto linkado: ${projectRef}`)

  // Confirma o histórico sincronizado (dry-run, SEM mutação).
  const dry = tryExecOut(sb, ['db', 'push', '--dry-run'])
  if (dry !== null && migrationDryRunSynced(dry)) {
    ok('Migration history sincronizado')
  }

  return true
}

/**
 * Binário do Supabase CLI a usar: SEMPRE a versão local pinada do projeto
 * (node_modules/.bin/supabase, instalada pelo npm ci) quando existir — uma
 * instalação global arbitrária nunca decide a versão. Só cai na global como
 * último recurso (npm ci não rodou), e o bootstrap sinaliza isso.
 */
export function resolveSupabaseBin(dest: string): { bin: string; local: boolean } {
  const localBin = path.join(dest, 'node_modules', '.bin', 'supabase')
  return fs.existsSync(localBin)
    ? { bin: localBin, local: true }
    : { bin: 'supabase', local: false }
}

/** Lê o ref que o `supabase link` gravou em supabase/.temp, para validar o alvo. */
function readLinkedRef(dest: string): string | null {
  try {
    return fs
      .readFileSync(path.join(dest, 'supabase', '.temp', 'project-ref'), 'utf8')
      .trim()
  } catch {
    return null
  }
}

export async function runBootstrap(opts: {
  projectId: string
  url: string
  dir?: string
  host?: 'claude-code' | 'codex'
  /**
   * APOSENTADO (v3.1 finalização): preview e daemon agora sobem SEMPRE, sem
   * flag — zero-config significa não ter uma opção pra "ligar" o básico.
   * Aceito só para não quebrar quem ainda passa `--start`; sem efeito.
   */
  start?: boolean
}): Promise<void> {
  const baseUrl = opts.url.replace(/\/$/, '')
  console.log('\nSupremo Bootstrap\n')

  // Aviso de runtime ANTES de instalar qualquer coisa (seção 8) — nunca
  // bloqueia (confirmado não-fatal), mas nunca fica silencioso também.
  const nodeCheck = checkNodeVersion(process.version)
  if (nodeCheck.status === 'warn') {
    console.log(`⚠ ${nodeCheck.message}\n`)
  }

  // Device flow do Supremo pelo padrão único do Auth Orchestrator: ENTER → abre o
  // browser no fluxo oficial → aguarda → detecta. URL/código só como fallback.
  // (holder para o config, que o passo authorize preenche.)
  const held: { config: BootstrapConfig | null } = { config: null }
  const supremoOk = await ensureAuthorized({
    name: 'Supremo',
    prompt: 'Supremo precisa autorizar esta máquina. Pressione ENTER para continuar…',
    isAuthorized: () => held.config !== null,
    authorize: async () => {
      const flow = await startDeviceFlow(baseUrl, opts.projectId)
      const opened = await openBrowser(flow.verificationUriComplete)
      if (!opened) {
        console.log('\n  Não consegui abrir o navegador. Abra manualmente:')
        console.log(`  ${flow.verificationUriComplete}`)
        console.log(`  Código: ${flow.userCode}`)
      }
      console.log('Aguardando autorização…')
      held.config = await pollForConfig(
        baseUrl,
        flow.deviceCode,
        flow.intervalSec,
        flow.expiresAt,
      )
    },
  })
  const config = held.config
  if (!supremoOk || !config) {
    throw new Error('Supremo não autorizado — rode o bootstrap de novo.')
  }
  console.log(`  Projeto: ${config.project.name}`)

  const dest = targetDir(config.repo.fullName, opts.dir)
  if (fs.existsSync(dest)) {
    throw new Error(`Já existe ${dest} — remova ou use --dir para outro caminho.`)
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true })

  // Clone sem token na URL/argv/.git/config: token só na env do processo git.
  run('git', gitCloneArgs(config.repo.fullName, config.repo.branch, dest), undefined, {
    ...process.env,
    SUPREMO_GIT_TOKEN: config.gitToken,
  })
  ok('Repository clonado')

  // .env.local (gitignored no scaffold). Nunca imprimimos o conteúdo. Só públicas.
  fs.writeFileSync(path.join(dest, '.env.local'), buildEnvFile(config.env), {
    mode: 0o600,
  })
  ok('Environment público configurado')
  fs.mkdirSync(path.join(dest, '.supremo'), { recursive: true })
  fs.writeFileSync(path.join(dest, '.supremo/database.json'), JSON.stringify(config.database ?? {
    environment: 'unknown', projectRef: config.supabase?.projectRef ?? null, automaticMigrations: false,
  }, null, 2) + '\n')

  run('npm', ['ci'], dest)
  ok('Dependências instaladas')

  // Linka o checkout ao Supabase remoto (auth guiada + link + validação do ref),
  // para o agente operar o banco online. Antes do baseline: a experiência final
  // mostra os passos do Supabase e só então "Verify passou".
  const linked = config.supabase?.projectRef
    ? await linkSupabaseRemote(dest, config.supabase)
    : false

  let setupSucceeded = false
  try {
    run('npm', ['run', 'setup:local'], dest)
    setupSucceeded = true
    ok('Verify passou')
  } catch {
    console.error('• setup:local falhou. Instalação incompleta será marcada not_ready.')
  }

  if (linked) ok('Claude/Codex prontos para trabalhar no Supabase online')

  // v3.1 item 4: identidade da máquina no keychain (nunca no projeto) + daemon de
  // checkpoint pronto. Assim o push é silencioso — o agente só faz checkpoint local.
  // Ordem DETERMINÍSTICA: o secret é salvo e CONFIRMADO gravado antes de subir o
  // daemon — nunca "declara pronto" e só depois tenta salvar o secret.
  let daemonRunning = false
  let npmScriptsCompatible: boolean | null = null
  if (config.daemon) {
    try {
      const keychainModule = await import('./keychain')
      const keychain = keychainModule.resolveKeychain()
      keychain.save(config.project.id, config.daemon.deviceSecret)
      // Confirma que o secret está de fato recuperável ANTES de subir o
      // daemon (sem isto, um keychain "salvou" mas não persistiu — silencioso
      // até o daemon falhar autenticação bem mais tarde).
      if (keychain.get(config.project.id) !== config.daemon.deviceSecret) {
        throw new Error('Secret não confirmado no keychain após salvar.')
      }
      ok('Máquina autorizada (checkpoint daemon) — identidade no keychain')
      const { ensureDaemon, daemonStatus } = await import('./daemon')
      ensureDaemon(dest)
      daemonRunning = daemonStatus(dest).running
      if (daemonRunning) {
        ok('Checkpoint daemon no ar — push/PR em background (npm run daemon:status)')
      }
      // Roda o MESMO comando que "npm run daemon:status" rodaria, agora — pega
      // uma CLI publicada desatualizada ANTES de declarar o projeto pronto.
      npmScriptsCompatible = checkNpmScriptsCompatible(dest)
      if (npmScriptsCompatible) {
        ok('Scripts de checkpoint/daemon compatíveis com a CLI instalada')
      }
    } catch {
      console.log(
        '• Não consegui preparar o checkpoint daemon automaticamente.\n' +
          '  Rode depois: npm run daemon:ensure\n',
      )
    }
  }

  // v3.1 finalização: preview PERSISTENTE sobe SEMPRE (zero-config — o usuário
  // nunca deveria precisar rodar "npm run preview:ensure" à mão). `--start` foi
  // aposentado: isto já não é mais opcional, é parte do bootstrap.
  let previewHealthy = false
  try {
    run('npm', ['run', 'preview:ensure'], dest)
    previewHealthy = checkPreviewHealthy(dest)
    if (previewHealthy) ok('Preview no ar (npm run preview:status)')
  } catch {
    console.log(
      '• Não consegui subir o preview automaticamente.\n  Rode depois: npm run preview:ensure\n',
    )
  }

  // Só declara "pronto" se o workflow LOCAL prometido está de fato operacional
  // (não só "os passos rodaram sem lançar exceção") — device identity, daemon
  // E preview saudáveis, nesta ordem.
  const adapters = inspectHostAdapters(dest)
  const selectedHost = opts.host ?? (process.env.CLAUDECODE ? 'claude-code' : 'codex')
  const selectedAdapter = adapters.adapters[selectedHost]
  const readiness = validateLocalReadiness({
    projectJsonOk: projectIdentityValid(fs.existsSync(path.join(dest, '.supremo/project.json'))
      ? fs.readFileSync(path.join(dest, '.supremo/project.json'), 'utf8') : null, config.project.id),
    hasDaemonIdentity: Boolean(config.daemon),
    daemonRunning,
    npmScriptsCompatible,
    previewHealthy,
    setupSucceeded,
    gitHooksVerified: gitHooksVerified(dest),
    lifecycleVerified: selectedAdapter.verified,
    validationWorkerAvailable: validationWorkerHealthy(dest),
    databaseEnvironmentReady: config.database?.environment === 'development' &&
      (!config.supabase || (linked && config.database.projectRef === config.supabase.projectRef)),
    integrationMode: selectedAdapter.integrationMode,
  })
  readiness.issues.push(...selectedAdapter.issues)
  fs.writeFileSync(path.join(dest, '.supremo/bootstrap-readiness.json'), JSON.stringify({
    ...readiness, projectId: config.project.id, checkedAt: new Date().toISOString(),
  }, null, 2) + '\n')

  if (readiness.ok) {
    const url = previewStatusUrl(tryExecOutIn(process.execPath, ['scripts/preview.mjs', 'status'], dest)) ?? 'consulte preview:status'
    console.log(
      `\nInfraestrutura pronta para ${selectedHost} com ciclo comprovado:\n\n  ${dest}\n  Preview: ${url}\n`,
    )
  } else {
    console.log(`\nProjeto criado; estado ${readiness.state}, integração ${readiness.integrationMode}:\n`)
    for (const issue of readiness.issues) console.log(`  • ${issue}`)
    console.log(
      `\n  O código funciona normalmente; resolva o(s) ponto(s) acima antes de\n` +
        `  contar com checkpoint/publicação/preview automáticos.\n\n  Pasta: ${dest}\n`,
    )
    if (readiness.state === 'not_ready') throw new Error('Bootstrap incompleto: consulte .supremo/bootstrap-readiness.json.')
  }
}
