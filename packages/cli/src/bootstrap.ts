import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

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
  }
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

/**
 * Linka o checkout ao Supabase remoto do projeto, via CLI oficial, para o agente
 * (Claude/Codex) operar o banco online sem depender do MCP.
 *
 *   • reaproveita o `supabase login` se já autenticado; senão conduz o login
 *     oficial (browser) — o token fica no keychain do SO, nunca por nós;
 *   • `supabase link --project-ref <ref>` grava o ref em `supabase/.temp`
 *     (gitignored), prendendo o checkout SÓ a este projeto (sem risco de aplicar
 *     migration no projeto errado);
 *   • a senha do banco (quando vem) vai só pela env do processo → a CLI a grava
 *     no keychain. Nunca em `.env.local`, Git, argv, log ou stdout.
 *
 * Falha aqui não quebra o bootstrap: o app local já está pronto; o link é o extra
 * para operar o banco online. Sempre imprime o comando manual em caso de erro.
 */
function linkSupabaseRemote(
  dest: string,
  supabase: { projectRef: string; dbPassword?: string },
): void {
  const { projectRef, dbPassword } = supabase
  const manual = `cd ${dest} && supabase link --project-ref ${projectRef}`

  if (!tryExec('supabase', ['--version'])) {
    console.log(
      `\n• Supabase CLI não encontrado — pulei o link do banco online.\n` +
        `  Instale (macOS: brew install supabase/tap/supabase) e rode:\n    ${manual}\n`,
    )
    return
  }

  // Autenticação: reaproveita se já logado; senão, login oficial (browser). Uma
  // única chamada a `projects list` serve para detectar login E verificar acesso.
  let projects = tryExecOut('supabase', ['projects', 'list'])
  if (projects === null) {
    console.log('\nAutentique o Supabase CLI (abre no navegador)…')
    try {
      run('supabase', ['login'], dest)
    } catch {
      console.log(
        `• Login do Supabase não concluído — pulei o link.\n` +
          `  Rode depois: supabase login && ( ${manual} )\n`,
      )
      return
    }
    projects = tryExecOut('supabase', ['projects', 'list'])
  }
  if (projects === null) {
    console.log(`• Não consegui listar projetos do Supabase — pulei o link.\n    ${manual}\n`)
    return
  }
  ok('Supabase CLI autenticado')

  // Divergência de conta: o Supremo pode ter criado o projeto numa conta Supabase
  // diferente da que está logada no CLI. Nesse caso NÃO enviamos nenhum token —
  // orientamos o dev a logar na conta certa (a que ele conectou ao Supremo).
  if (!projectListHasRef(projects, projectRef)) {
    console.log(
      `\n• A conta logada no Supabase CLI não tem acesso ao projeto ${projectRef}.\n` +
        `  Faça login com a conta Supabase que você conectou ao Supremo (a dona\n` +
        `  deste projeto) e rode o link:\n` +
        `    supabase login\n    ${manual}\n`,
    )
    return
  }

  // Link: senha só na env (nunca em argv); ref grava em supabase/.temp.
  try {
    execFileSync('supabase', supabaseLinkArgs(projectRef), {
      cwd: dest,
      env: supabaseLinkEnv(process.env, dbPassword),
      stdio: ['ignore', 'ignore', 'inherit'],
    })
  } catch {
    console.log(`• Não consegui linkar automaticamente. Rode:\n    ${manual}\n`)
    return
  }
  ok(`Supabase remoto linkado: ${projectRef}`)
  ok('Agente pronto para trabalhar no banco online')
}

export async function runBootstrap(opts: {
  projectId: string
  url: string
  dir?: string
  start?: boolean
}): Promise<void> {
  const baseUrl = opts.url.replace(/\/$/, '')
  console.log('\nSupremo Bootstrap\n')

  const flow = await startDeviceFlow(baseUrl, opts.projectId)
  console.log('Abra este link no navegador para autorizar esta máquina:\n')
  console.log(`  ${flow.verificationUriComplete}`)
  console.log(`\n  Código: ${flow.userCode}\n`)
  console.log('Aguardando autorização…')

  const config = await pollForConfig(
    baseUrl,
    flow.deviceCode,
    flow.intervalSec,
    flow.expiresAt,
  )
  ok('Autorização concedida')
  ok(`Projeto: ${config.project.name}`)

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
  ok(`Repository clonado (token ${config.gitTokenScope}, efêmero)`)

  // .env.local (gitignored no scaffold). Nunca imprimimos o conteúdo.
  fs.writeFileSync(path.join(dest, '.env.local'), buildEnvFile(config.env), {
    mode: 0o600,
  })
  ok(
    `Environment configurado (${Object.keys(config.env).length} variável(is) pública(s))`,
  )

  run('npm', ['ci'], dest)
  ok('Dependências instaladas')

  try {
    run('npm', ['run', 'setup:local'], dest)
    ok('Setup local + baseline')
  } catch {
    console.log('• setup:local pulado (rode "npm run setup:local" manualmente)')
  }

  // Linka o checkout ao Supabase remoto para o agente operar o banco online.
  if (config.supabase?.projectRef) {
    linkSupabaseRemote(dest, config.supabase)
  }

  console.log(`\nProjeto pronto:\n\n  ${dest}\n`)
  if (opts.start) {
    console.log('Iniciando o dev server (Ctrl+C para sair)…\n')
    run('npm', ['run', 'dev'], dest)
  } else {
    console.log(`Agora:\n\n  cd ${dest}\n  npm run dev\n`)
  }
}
