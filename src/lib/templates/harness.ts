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
    'security:audit': 'node scripts/security-audit.js --deep',
    'security:report': 'node scripts/security-audit.js --report',
  }
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

console.log('\\n✓ pronto. Agora: npm run dev\\n')
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
    '.githooks/pre-commit': preCommitHook,
    '.githooks/pre-push': prePushHook,
  }
}
