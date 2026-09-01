import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
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
}

// ── Helpers puros (testáveis) ───────────────────────────────────────────────

export function buildEnvFile(env: Record<string, string>): string {
  return (
    Object.entries(env)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n') + '\n'
  )
}

export function targetDir(repoFullName: string, baseDir?: string): string {
  const name = repoFullName.split('/').pop() || 'projeto'
  return path.join(baseDir ?? path.join(os.homedir(), 'Supremo'), name)
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

function openBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32'
        ? 'cmd'
        : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref()
  } catch {
    // sem navegador: o usuário abre manualmente (URL impressa)
  }
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

export async function runBootstrap(opts: {
  projectId: string
  url: string
  dir?: string
  start?: boolean
}): Promise<void> {
  const baseUrl = opts.url.replace(/\/$/, '')
  console.log('\nSupremo Bootstrap\n')

  const flow = await startDeviceFlow(baseUrl, opts.projectId)
  console.log('Abra no navegador para autorizar esta máquina:\n')
  console.log(`  ${flow.verificationUriComplete}`)
  console.log(`\n  Código: ${flow.userCode}\n`)
  openBrowser(flow.verificationUriComplete)
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

  console.log(`\nProjeto pronto:\n\n  ${dest}\n`)
  if (opts.start) {
    console.log('Iniciando o dev server (Ctrl+C para sair)…\n')
    run('npm', ['run', 'dev'], dest)
  } else {
    console.log(`Agora:\n\n  cd ${dest}\n  npm run dev\n`)
  }
}
