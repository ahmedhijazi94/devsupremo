import {
  BROAD_FILE_COUNT,
  FULL_PATTERNS,
  QUICK_PATTERNS,
  SECURITY_PATTERNS,
  serializePatterns,
} from './verify-classifier'

/**
 * Local dev harness gerado no scaffold — a "velocidade durante o dev".
 *
 * Emite um `verify` adaptativo (QUICK/SECURITY/FULL escolhido pelo git diff),
 * `setup:local` idempotente, e git hooks. As REGRAS do verify vêm das mesmas
 * constantes do classificador do Supremo (serializadas), então o que o Supremo
 * testa é exatamente o que roda na máquina do dev — sem lógica duplicada à mão.
 *
 * Fonte ÚNICA de testes: uma pasta `tests/` só, usada por dev, hooks e CI.
 */

/** Scripts que o harness contribui ao package.json do projeto gerado. */
export function harnessPackageScripts(): Record<string, string> {
  return {
    typecheck: 'tsc --noEmit',
    verify: 'node scripts/verify.mjs',
    'verify:quick': 'node scripts/verify.mjs quick',
    'verify:security': 'node scripts/verify.mjs security',
    'verify:full': 'node scripts/verify.mjs full',
    'setup:local': 'node scripts/setup-local.mjs',
    'local:start': 'supabase start',
    'local:stop': 'supabase stop',
    // v3.1 — preview PERSISTENTE (infra da sessão, não processo do turno).
    'preview:ensure': 'node scripts/preview.mjs ensure',
    'preview:status': 'node scripts/preview.mjs status',
    'preview:stop': 'node scripts/preview.mjs stop',
    // v3.1 item 4 — checkpoint LOCAL (o agente só faz isto ao concluir um pedido)
    // e o checkpoint daemon (push/PR assíncronos; o agente NUNCA faz git push).
    // A CLI vem por npx (mesma entrega do bootstrap), sem tocar o lockfile.
    checkpoint: 'npx --yes supremo-cli checkpoint',
    'daemon:ensure': 'npx --yes supremo-cli daemon --ensure',
    'daemon:status': 'npx --yes supremo-cli daemon --status',
    'daemon:stop': 'npx --yes supremo-cli daemon --stop',
    'security:audit': 'node scripts/security-audit.js --deep',
    'security:report': 'node scripts/security-audit.js --report',
  }
}

/**
 * (PURO) Decisão do supervisor de preview a partir do estado observado — testável
 * sem I/O. `reuse` = há UMA instância viva e saudável; `restart` = processo vivo
 * mas não responde (zumbi) → matar e subir; `start` = nada rodando → subir.
 */
export function decidePreviewAction(state: {
  pidAlive: boolean
  healthy: boolean
}): 'reuse' | 'restart' | 'start' {
  if (state.pidAlive && state.healthy) return 'reuse'
  if (state.pidAlive && !state.healthy) return 'restart'
  return 'start'
}

/**
 * `scripts/preview.mjs` — supervisor determinístico do dev server (v3.1).
 *
 * O preview é INFRAESTRUTURA da sessão/projeto, não um processo do turno do agente.
 * Por isso o `next dev` sobe DESACOPLADO (detached + unref): sobrevive ao fim do
 * comando/turno, ao commit/push e ao verify. `ensure` mantém UMA instância saudável
 * (reusa / reinicia zumbi / inicia), em porta estável, e espera readiness.
 */
export function previewSupervisorScript(): string {
  return `#!/usr/bin/env node
// GERADO pelo Supremo (v3.1) — supervisor do preview. NÃO rode 'next dev' à mão:
//   node scripts/preview.mjs ensure   → garante 1 preview saudável (reusa/inicia)
//   node scripts/preview.mjs status    → estado (json)
//   node scripts/preview.mjs stop      → para
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync, openSync } from 'node:fs'
import { join } from 'node:path'
import http from 'node:http'

const ROOT = process.cwd()
const DIR = join(ROOT, '.supremo')
const PIDFILE = join(DIR, 'preview.pid')
const LOG = join(DIR, 'preview.log')
const HOST = '127.0.0.1'
const PORT = Number(process.env.PORT || 3000) // porta ESTÁVEL do projeto

function readPid() {
  try { return Number(readFileSync(PIDFILE, 'utf8').trim()) || null } catch { return null }
}
function alive(pid) {
  if (!pid) return false
  try { process.kill(pid, 0); return true } catch { return false }
}
function health(timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get({ host: HOST, port: PORT, path: '/', timeout: timeoutMs }, (res) => {
      res.resume(); resolve((res.statusCode || 0) > 0)
    })
    req.on('error', () => resolve(false))
    req.on('timeout', () => { req.destroy(); resolve(false) })
  })
}
async function waitReady(tries = 90) {
  for (let i = 0; i < tries; i++) { if (await health()) return true; await new Promise((r) => setTimeout(r, 1000)) }
  return false
}
// Mesma decisão pura de harness.decidePreviewAction (mantidas em sincronia).
function decide(pidAlive, healthy) {
  if (pidAlive && healthy) return 'reuse'
  if (pidAlive && !healthy) return 'restart'
  return 'start'
}
function startDetached() {
  mkdirSync(DIR, { recursive: true })
  const out = openSync(LOG, 'a')
  // DESACOPLADO do pai: sobrevive ao fim do turno/comando do agente.
  const child = spawn('npm', ['run', 'dev', '--', '--port', String(PORT)], {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', out, out],
    env: { ...process.env, PORT: String(PORT) },
  })
  child.unref()
  writeFileSync(PIDFILE, String(child.pid))
  return child.pid
}
async function ensure() {
  const pid = readPid()
  const action = decide(alive(pid), await health())
  if (action === 'reuse') {
    console.log(\`✓ preview já no ar (pid \${pid}, http://localhost:\${PORT})\`)
    return
  }
  if (action === 'restart') {
    try { process.kill(pid) } catch {}
    rmSync(PIDFILE, { force: true })
  }
  const newPid = startDetached()
  const ok = await waitReady()
  console.log(ok
    ? \`✓ preview no ar (pid \${newPid}, http://localhost:\${PORT})\`
    : \`• preview iniciando (pid \${newPid}) — aquecendo; veja .supremo/preview.log\`)
}
async function status() {
  const pid = readPid()
  const up = alive(pid)
  console.log(JSON.stringify({ running: up, healthy: up && (await health()), pid: pid ?? null, port: PORT, url: \`http://localhost:\${PORT}\` }))
}
function stop() {
  const pid = readPid()
  if (alive(pid)) { try { process.kill(pid) } catch {} }
  rmSync(PIDFILE, { force: true })
  console.log('✓ preview parado')
}
const cmd = process.argv[2] || 'ensure'
if (cmd === 'ensure') await ensure()
else if (cmd === 'status') await status()
else if (cmd === 'stop') stop()
else { console.error('uso: node scripts/preview.mjs ensure|status|stop'); process.exit(1) }
void existsSync
`
}

/** O `scripts/verify.mjs` — classificador embutido a partir das regras do Supremo. */
export function verifyScript(): string {
  return `#!/usr/bin/env node
// GERADO pelo Supremo — verify adaptativo. NÃO edite as regras à mão: elas vêm
// do classificador do Supremo (fonte única). Uso:
//   node scripts/verify.mjs            → auto (git diff working+staged)
//   node scripts/verify.mjs --staged   → auto, só staged (usado no pre-commit)
//   node scripts/verify.mjs quick|security|full → força o nível
import { execSync } from 'node:child_process'

const FULL_PATTERNS = ${serializePatterns(FULL_PATTERNS)}
const SECURITY_PATTERNS = ${serializePatterns(SECURITY_PATTERNS)}
const QUICK_PATTERNS = ${serializePatterns(QUICK_PATTERNS)}
const BROAD_FILE_COUNT = ${BROAD_FILE_COUNT}

function changedFiles(stagedOnly) {
  try {
    const cmds = stagedOnly
      ? ['git diff --cached --name-only']
      : ['git diff --name-only HEAD', 'git diff --cached --name-only']
    const set = new Set()
    for (const c of cmds) {
      for (const line of execSync(c, { encoding: 'utf8' }).split('\\n')) {
        const p = line.trim()
        if (p) set.add(p)
      }
    }
    return [...set]
  } catch {
    return []
  }
}

const anyMatch = (p, pats) => pats.some((re) => re.test(p))

function classify(paths) {
  if (paths.length === 0) return { level: 'quick', reason: 'Nada alterado.' }
  const full = paths.some((p) => anyMatch(p, FULL_PATTERNS))
  const security = paths.some((p) => anyMatch(p, SECURITY_PATTERNS))
  const cosmetic = paths.every((p) => anyMatch(p, QUICK_PATTERNS))
  if (full || paths.length > BROAD_FILE_COUNT)
    return { level: 'full', reason: full ? 'Arquitetura/build/config.' : \`Mudança ampla (\${paths.length}).\` }
  if (security) return { level: 'security', reason: 'Área sensível à segurança.' }
  if (cosmetic) return { level: 'quick', reason: 'Só cosmético.' }
  return { level: 'quick', reason: 'Alteração de baixo risco.' }
}

// Os testes de RLS (*.rls.test.ts) exigem um Postgres real (service_role +
// supabase local). Num bootstrap fresco isso não existe (por design: só env
// pública chega). Então excluímos RLS do vitest padrão e só rodamos os testes
// de RLS quando há Supabase local; senão, o gate "Políticas RLS" do CI cobre.
const hasLocalDb = Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY)
const UNIT = 'vitest run --exclude "**/*.rls.test.ts"'
const rlsStep = hasLocalDb ? [['rls / isolamento', 'vitest run rls.test']] : []

const STEPS = {
  quick: [
    ['typecheck', 'tsc --noEmit'],
    ['lint', 'eslint'],
    ['testes afetados', 'vitest run --changed HEAD --passWithNoTests --exclude "**/*.rls.test.ts"'],
    ['secret scan', 'node scripts/security-audit.js --staged'],
  ],
  security: [
    ['typecheck', 'tsc --noEmit'],
    ['lint', 'eslint'],
    ['unit + integração', UNIT],
    ...rlsStep,
    ['secret scan', 'node scripts/security-audit.js'],
  ],
  full: [
    ['typecheck', 'tsc --noEmit'],
    ['lint', 'eslint'],
    ['unit + integração', UNIT],
    ...rlsStep,
    ['secret scan', 'node scripts/security-audit.js'],
    ['build', 'next build'],
  ],
}

const args = process.argv.slice(2)
const stagedOnly = args.includes('--staged')
const forced = args.find((a) => ['quick', 'security', 'full'].includes(a))
const paths = changedFiles(stagedOnly)
const { level, reason } = forced ? { level: forced, reason: 'Nível forçado.' } : classify(paths)

console.log(\`\\n▸ verify [\${level.toUpperCase()}] — \${reason} (\${paths.length} arquivo(s))\\n\`)
const t0 = Date.now()
for (const [label, cmd] of STEPS[level]) {
  process.stdout.write(\`  • \${label}… \`)
  try {
    execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'] })
    console.log('ok')
  } catch (err) {
    console.log('FALHOU')
    if (err.stdout) process.stderr.write(err.stdout.toString())
    if (err.stderr) process.stderr.write(err.stderr.toString())
    console.error(\`\\n✗ verify \${level} falhou em: \${label}\\n\`)
    process.exit(1)
  }
}
if (!hasLocalDb && (level === 'security' || level === 'full')) {
  console.log('  ℹ RLS pulado (sem Supabase local) — validado no gate "Políticas RLS" do CI. Para rodar local: npm run local:start && npm run test:rls')
}
console.log(\`\\n✓ verify \${level} passou em \${((Date.now() - t0) / 1000).toFixed(1)}s\\n\`)
`
}

/** O `scripts/setup-local.mjs` — idempotente, prepara a máquina pós-clone. */
export function setupLocalScript(): string {
  return `#!/usr/bin/env node
// GERADO pelo Supremo — setup local idempotente. Rodar de novo não destrói nada.
import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'

const step = (label, fn) => {
  process.stdout.write(\`  • \${label}… \`)
  try { fn(); console.log('ok') }
  catch (e) { console.log('FALHOU'); console.error(String(e?.message ?? e)); process.exit(1) }
}

console.log('\\nSupremo — setup local\\n')

step('runtime Node', () => {
  const major = Number(process.versions.node.split('.')[0])
  if (major < 18) throw new Error(\`Node \${process.versions.node} < 18\`)
})

step('.env.local', () => {
  if (!existsSync('.env.local')) {
    throw new Error('.env.local ausente — rode o bootstrap do Supremo primeiro.')
  }
})

step('dependências', () => {
  if (!existsSync('node_modules')) execSync('npm ci', { stdio: 'inherit' })
})

step('git hooks', () => {
  execSync('git config core.hooksPath .githooks', { stdio: 'ignore' })
})

step('baseline (verify quick)', () => {
  execSync('node scripts/verify.mjs quick', { stdio: 'inherit' })
})

console.log('\\n✓ pronto. Preview persistente: npm run preview:ensure\\n')
`
}

const preCommitHook = `#!/bin/sh
# GERADO pelo Supremo — validação rápida/adaptativa do que está staged.
exec node scripts/verify.mjs --staged
`

const prePushHook = `#!/bin/sh
# GERADO pelo Supremo (v3) — defesa local em profundidade.
#
# 1) NUNCA empurrar direto para a main. A integração na main é do GitHub/Supremo
#    (assíncrona), só com os required checks do HEAD atual verdes. No GitHub Free
#    privado, sem branch protection nativa, este hook é a barreira local que impede
#    o push direto. Trabalhe sempre numa branch de desenvolvimento.
while read -r _local_ref _local_sha remote_ref _remote_sha; do
  case "$remote_ref" in
    refs/heads/main|refs/heads/master)
      echo "✗ Push direto para a main bloqueado. Trabalhe numa branch de desenvolvimento;" >&2
      echo "  a main é integrada pelos gates (auto-merge), nunca por push direto." >&2
      exit 1
      ;;
  esac
done
# 2) validação adaptativa antes do push; o GitHub CI é a barreira independente final.
exec node scripts/verify.mjs
`

/**
 * Todos os arquivos do harness (relativos à raiz do projeto gerado). O conjunto
 * base é capability-agnóstico: o verify decide o nível pelo git diff em runtime,
 * então não precisa ser parametrizado por capability aqui.
 */
export function harnessFiles(): Record<string, string> {
  return {
    'scripts/verify.mjs': verifyScript(),
    'scripts/setup-local.mjs': setupLocalScript(),
    'scripts/preview.mjs': previewSupervisorScript(),
    '.githooks/pre-commit': preCommitHook,
    '.githooks/pre-push': prePushHook,
  }
}
