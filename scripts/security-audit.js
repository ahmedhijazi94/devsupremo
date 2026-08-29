#!/usr/bin/env node
/**
 * SUPREMO — Auditoria de segurança estática
 *
 * Roda sem IA e sem rede. Cinco categorias:
 *   1. RLS / isolamento entre contas
 *   2. Autorização em Server Actions e Route Handlers
 *   3. IDOR — acesso a objeto por ID sem checar dono
 *   4. Segredos em código
 *   5. XSS e injeção
 *
 * Uso: node scripts/security-audit.js [--strict] [--json]
 *   --strict  sai com código 1 se houver achado CRITICAL ou HIGH
 *   --json    imprime só o relatório JSON
 *
 * Princípio de calibragem: um gate que grita errado é um gate que a equipe
 * aprende a ignorar. Toda regra aqui precisa ter falso positivo próximo de
 * zero — quando em dúvida, a regra não dispara.
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const args = process.argv.slice(2)
const STRICT = args.includes('--strict')
const JSON_ONLY = args.includes('--json')

const COLORS = {
  CRITICAL: '\x1b[41m\x1b[37m',
  HIGH: '\x1b[31m',
  MEDIUM: '\x1b[33m',
  LOW: '\x1b[34m',
  OK: '\x1b[32m',
  DIM: '\x1b[2m',
  RESET: '\x1b[0m',
}

const findings = []
const strengths = []

function say(message) {
  if (!JSON_ONLY) console.log(message)
}

function finding(severity, category, file, line, code, reason) {
  findings.push({ severity, category, file, line, code: code.trim(), reason })
  const color = COLORS[severity] ?? COLORS.RESET
  say(`${color}[${severity}][${category}]${COLORS.RESET} ${file}:${line}`)
  say(`${COLORS.DIM}  ${code.trim().slice(0, 110)}${COLORS.RESET}`)
  say(`  ${reason}\n`)
}

function strength(message) {
  strengths.push(message)
  say(`${COLORS.OK}  ✓${COLORS.RESET} ${message}`)
}

function section(title) {
  say(`\n${COLORS.DIM}${'─'.repeat(64)}${COLORS.RESET}`)
  say(`  ${title}`)
  say(`${COLORS.DIM}${'─'.repeat(64)}${COLORS.RESET}\n`)
}

// ─────────────────────────────────────────────────────────────
// Coleta
// ─────────────────────────────────────────────────────────────

const IGNORED_DIRS = new Set([
  'node_modules',
  '.next',
  '.git',
  'dist',
  'build',
  'out',
  'coverage',
  '.vercel',
  'playwright-report',
  'test-results',
])

function collectFiles(dir, extensions) {
  const results = []
  if (!fs.existsSync(dir)) return results

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORED_DIRS.has(entry.name)) continue

    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      results.push(...collectFiles(full, extensions))
    } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
      results.push(full)
    }
  }
  return results
}

const rel = (file) => path.relative(ROOT, file)

/**
 * Remove comentários e literais de string.
 *
 * Sem isto, a auditoria acusa a própria documentação: um comentário que
 * explica o que NÃO fazer vira um achado. Foi assim que a versão anterior
 * gerou boa parte dos seus falsos positivos.
 */
function stripNoise(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length))
    .replace(/`(?:[^`\\]|\\.)*`/g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/'(?:[^'\\\n]|\\.)*'/g, (m) => "'" + ' '.repeat(Math.max(0, m.length - 2)) + "'")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, (m) => '"' + ' '.repeat(Math.max(0, m.length - 2)) + '"')
}

const tsFiles = collectFiles(path.join(ROOT, 'src'), ['.ts', '.tsx'])
  .concat(collectFiles(path.join(ROOT, 'app'), ['.ts', '.tsx']))
  .concat(collectFiles(path.join(ROOT, 'lib'), ['.ts', '.tsx']))
  .filter((file) => !file.endsWith('.test.ts') && !file.endsWith('.test.tsx'))

const sqlFiles = collectFiles(path.join(ROOT, 'supabase'), ['.sql'])

say(`\n${COLORS.DIM}Supremo — auditoria de segurança${COLORS.RESET}`)
say(`${COLORS.DIM}${tsFiles.length} arquivos TypeScript · ${sqlFiles.length} migrations${COLORS.RESET}`)

// ═════════════════════════════════════════════════════════════
// 1. RLS
// ═════════════════════════════════════════════════════════════
section('1 · Row Level Security')

let tablesTotal = 0
let tablesProtected = 0

for (const file of sqlFiles) {
  const source = fs.readFileSync(file, 'utf8')
  const lines = source.split('\n')

  const created = [
    ...source.matchAll(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?["']?([\w.]+)["']?/gi),
  ]

  for (const match of created) {
    const qualified = match[1]
    const table = qualified.split('.').pop()
    tablesTotal++

    const rlsPattern = new RegExp(
      `ALTER TABLE\\s+(?:IF EXISTS\\s+)?["']?(?:\\w+\\.)?${table}["']?\\s+ENABLE ROW LEVEL SECURITY`,
      'i'
    )

    if (rlsPattern.test(source)) {
      tablesProtected++
    } else {
      const lineNumber =
        lines.findIndex((l) => l.includes(match[0])) + 1 || 1
      finding(
        'CRITICAL',
        'RLS',
        rel(file),
        lineNumber,
        match[0],
        `Tabela "${table}" criada sem RLS. Sem isso, a anon key lê a tabela inteira. ` +
          `Adicione: ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`
      )
    }
  }

  // Policy que libera tudo é pior que policy nenhuma: parece proteção.
  const permissive = [
    ...source.matchAll(
      /CREATE POLICY\s+["'][^"']+["']\s+ON\s+["']?(\w+)["']?[\s\S]{0,200}?(USING|WITH CHECK)\s*\(\s*true\s*\)/gi
    ),
  ]

  for (const match of permissive) {
    const lineNumber = lines.findIndex((l) => l.includes(`CREATE POLICY`) && l.includes(match[1])) + 1 || 1
    finding(
      'HIGH',
      'RLS',
      rel(file),
      lineNumber,
      match[0].split('\n')[0],
      `Policy em "${match[1]}" usa ${match[2]} (true) — libera a tabela para qualquer um. ` +
        `Escreva a condição de dono: auth.uid() = user_id.`
    )
  }
}

if (tablesTotal > 0 && tablesProtected === tablesTotal) {
  strength(`RLS ativo nas ${tablesTotal} tabelas das migrations`)
}

// Service role nunca pode alcançar o bundle do cliente.
for (const file of tsFiles) {
  const source = fs.readFileSync(file, 'utf8')
  if (!source.includes('SUPABASE_SERVICE_ROLE_KEY')) continue

  const lines = source.split('\n')
  const isClient = /^\s*['"]use client['"]/m.test(source)

  if (isClient) {
    const lineNumber = lines.findIndex((l) => l.includes('SUPABASE_SERVICE_ROLE_KEY')) + 1
    finding(
      'CRITICAL',
      'RLS',
      rel(file),
      lineNumber,
      lines[lineNumber - 1] ?? '',
      'Service role key referenciada em Client Component. Ela ignora RLS e ' +
        'iria para o bundle do navegador.'
    )
  }
}

// ═════════════════════════════════════════════════════════════
// 2. Autorização
// ═════════════════════════════════════════════════════════════
section('2 · Autorização em Server Actions e Route Handlers')

/** Formas aceitas de provar que a sessão foi verificada. */
const AUTH_MARKERS = [
  /auth\s*\.\s*getUser\s*\(/,
  /requireUser\s*\(/,
  /requireProjectOwner\s*\(/,
  /getSession\s*\(/,
  /resolveMcpToken\s*\(/,
  /parseAuthorizationHeader\s*\(/,
  /CRON_SECRET/,
  // O callback de OAuth roda antes de existir sessão — é ele que a cria.
  /exchangeCodeForSession\s*\(/,
]

let guardedActions = 0

for (const file of tsFiles) {
  const source = fs.readFileSync(file, 'utf8')
  const clean = stripNoise(source)
  const lines = source.split('\n')

  const isServerAction = /^\s*['"]use server['"]/m.test(source)
  const isRouteHandler = /\/route\.tsx?$/.test(file)
  if (!isServerAction && !isRouteHandler) continue

  // Um arquivo que só reexporta ou só define tipos não tem o que proteger.
  const hasExportedFunction = /export\s+(async\s+)?function\s+\w+/.test(clean)
  if (!hasExportedFunction) continue

  const authenticated = AUTH_MARKERS.some((marker) => marker.test(clean))

  if (authenticated) {
    guardedActions++
    continue
  }

  const lineNumber =
    lines.findIndex((l) => /export\s+(async\s+)?function/.test(l)) + 1 || 1

  finding(
    'CRITICAL',
    'AUTHZ',
    rel(file),
    lineNumber,
    lines[lineNumber - 1] ?? '',
    'Server Action ou Route Handler sem verificação de sessão. São endpoints ' +
      'POST públicos: qualquer um pode chamá-los diretamente. Use requireUser() ' +
      'ou supabase.auth.getUser() antes de qualquer acesso a dados.'
  )
}

if (guardedActions > 0) {
  strength(`${guardedActions} action(s)/handler(s) com verificação de sessão`)
}

// ═════════════════════════════════════════════════════════════
// 3. IDOR
// ═════════════════════════════════════════════════════════════
section('3 · IDOR — objeto acessado por ID sem checar dono')

/**
 * Extrai as cadeias que começam em `.from(` e vão até o fim da expressão.
 * A versão anterior casava `.update(` em qualquer lugar do arquivo — foi
 * assim que `decipher.update()` virou "IDOR no Supabase".
 */
function supabaseChains(source) {
  const chains = []
  const pattern = /\.from\s*\(\s*['"`](\w+)['"`]\s*\)/g
  let match

  while ((match = pattern.exec(source)) !== null) {
    const start = match.index
    let end = start
    let depth = 0
    let seenBody = false

    for (let i = start; i < source.length && i < start + 1200; i++) {
      const char = source[i]
      if (char === '(') {
        depth++
        seenBody = true
      } else if (char === ')') {
        depth--
        if (seenBody && depth === 0) {
          const next = source.slice(i + 1, i + 3)
          // A cadeia continua enquanto houver `.metodo(`
          if (!/^\s*\.\s*$|^\s*\.\w/.test(next)) {
            end = i + 1
            break
          }
        }
      } else if (char === '\n' && depth === 0 && seenBody) {
        const rest = source.slice(i + 1, i + 40)
        if (!/^\s*\./.test(rest)) {
          end = i
          break
        }
      }
      end = i + 1
    }

    chains.push({
      table: match[1],
      text: source.slice(start, end),
      index: start,
    })
  }

  return chains
}

const OWNERSHIP_MARKERS = [
  /\.eq\s*\(\s*['"`]user_id['"`]/,
  /\.eq\s*\(\s*['"`]owner_id['"`]/,
  /\.match\s*\(\s*\{[^}]*user_id/,
]

/** Tabelas cujo dono não é uma coluna user_id da própria linha. */
const OWNERLESS_TABLES = new Set(['audit_logs', 'oauth_states'])

let ownershipChecked = 0

for (const file of tsFiles) {
  const source = fs.readFileSync(file, 'utf8')
  const clean = stripNoise(source)

  // Um repositório que exige userId por assinatura já é a checagem.
  const isScopedRepository = /repository\.ts$/.test(file)

  for (const chain of supabaseChains(clean)) {
    const writesOrReadsById =
      /\.(update|delete|upsert)\s*\(/.test(chain.text) ||
      /\.eq\s*\(\s*['"`]id['"`]/.test(chain.text)

    if (!writesOrReadsById) continue
    if (OWNERLESS_TABLES.has(chain.table)) continue

    const hasOwnership = OWNERSHIP_MARKERS.some((m) => m.test(chain.text))

    if (hasOwnership || isScopedRepository) {
      ownershipChecked++
      continue
    }

    const lineNumber = clean.slice(0, chain.index).split('\n').length
    finding(
      'HIGH',
      'IDOR',
      rel(file),
      lineNumber,
      chain.text.split('\n').slice(0, 2).join(' ').replace(/\s+/g, ' '),
      `Query em "${chain.table}" acessa objeto por ID sem filtrar por dono. ` +
        `Adicione .eq('user_id', user.id) — o RLS é a primeira camada, não a única.`
    )
  }
}

if (ownershipChecked > 0) {
  strength(`${ownershipChecked} query(s) com filtro explícito por dono`)
}

// ═════════════════════════════════════════════════════════════
// 4. Segredos
// ═════════════════════════════════════════════════════════════
section('4 · Segredos em código')

const SECRET_PATTERNS = [
  { name: 'GitHub PAT', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: 'Supabase PAT', pattern: /\bsbp_[a-f0-9]{40,}\b/ },
  { name: 'OpenAI', pattern: /\bsk-[A-Za-z0-9]{32,}\b/ },
  { name: 'Anthropic', pattern: /\bsk-ant-[A-Za-z0-9_-]{32,}\b/ },
  { name: 'AWS Access Key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'Chave privada', pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: 'JWT', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\./ },
]

/** Placeholder de documentação não é segredo. */
const PLACEHOLDER = /(your|seu|my|example|placeholder|xxx|\.\.\.|<[^>]+>|dummy|fake|test|sample)/i

let secretsFound = 0

for (const file of tsFiles.concat(collectFiles(ROOT, ['.json', '.yml', '.yaml']))) {
  if (/\.env\.example$/.test(file) || /package-lock\.json$/.test(file)) continue

  const lines = fs.readFileSync(file, 'utf8').split('\n')

  lines.forEach((line, index) => {
    for (const { name, pattern } of SECRET_PATTERNS) {
      const match = pattern.exec(line)
      if (!match) continue
      if (PLACEHOLDER.test(line)) continue

      secretsFound++
      finding(
        'CRITICAL',
        'SECRET',
        rel(file),
        index + 1,
        `${line.slice(0, 40)}…`,
        `Possível ${name} em código. Mova para variável de ambiente e ` +
          `revogue a credencial — ela já está no histórico do git.`
      )
    }
  })
}

if (secretsFound === 0) {
  strength('Nenhum segredo detectado no código')
}

// .gitignore precisa cobrir .env — entendendo glob, não só igualdade literal.
const gitignorePath = path.join(ROOT, '.gitignore')
if (fs.existsSync(gitignorePath)) {
  const patterns = fs
    .readFileSync(gitignorePath, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))

  const coversEnv = patterns.some((p) =>
    ['.env', '.env*', '.env.local', '*.local', '.env.*'].includes(p)
  )

  if (coversEnv) {
    strength('.gitignore cobre arquivos .env')
  } else {
    finding(
      'HIGH',
      'SECRET',
      '.gitignore',
      1,
      patterns.slice(0, 3).join(' · '),
      'Nenhum padrão cobrindo .env. Adicione a linha: .env*'
    )
  }
} else {
  finding('HIGH', 'SECRET', '.gitignore', 1, '(ausente)', 'Projeto sem .gitignore.')
}

// ═════════════════════════════════════════════════════════════
// 5. XSS e injeção
// ═════════════════════════════════════════════════════════════
section('5 · XSS e injeção')

let xssFound = 0

for (const file of tsFiles) {
  const source = fs.readFileSync(file, 'utf8')
  const clean = stripNoise(source)
  const lines = source.split('\n')

  const checks = [
    {
      pattern: /dangerouslySetInnerHTML/,
      severity: 'HIGH',
      reason:
        'dangerouslySetInnerHTML injeta HTML cru. Sanitize com DOMPurify ou ' +
        'renderize como texto.',
    },
    {
      pattern: /\.innerHTML\s*=/,
      severity: 'HIGH',
      reason: 'Atribuição a innerHTML. Use textContent, ou sanitize antes.',
    },
    {
      pattern: /\beval\s*\(|new\s+Function\s*\(/,
      severity: 'CRITICAL',
      reason: 'eval executa string como código. Não há uso legítimo aqui.',
    },
  ]

  for (const check of checks) {
    lines.forEach((line, index) => {
      const cleanLine = clean.split('\n')[index] ?? ''
      if (!check.pattern.test(cleanLine)) return

      xssFound++
      finding(check.severity, 'XSS', rel(file), index + 1, line, check.reason)
    })
  }
}

if (xssFound === 0) {
  strength('Nenhum vetor de XSS ou eval detectado')
}

// Zod como sinal de validação no servidor.
const usesZod = tsFiles.some((file) =>
  /from\s+['"]zod['"]/.test(fs.readFileSync(file, 'utf8'))
)
if (usesZod) strength('Validação de entrada com Zod presente')

// ═════════════════════════════════════════════════════════════
// Relatório
// ═════════════════════════════════════════════════════════════

const counts = findings.reduce((acc, f) => {
  acc[f.severity] = (acc[f.severity] ?? 0) + 1
  return acc
}, {})

const critical = counts.CRITICAL ?? 0
const high = counts.HIGH ?? 0
const medium = counts.MEDIUM ?? 0

section('Resumo')

say(`  Achados:    ${findings.length}`)
if (critical) say(`  ${COLORS.CRITICAL} CRITICAL ${COLORS.RESET}  ${critical}`)
if (high) say(`  ${COLORS.HIGH}HIGH${COLORS.RESET}      ${high}`)
if (medium) say(`  ${COLORS.MEDIUM}MEDIUM${COLORS.RESET}    ${medium}`)
say(`  Pontos confirmados: ${strengths.length}`)

const report = {
  timestamp: new Date().toISOString(),
  scanned: { typescript: tsFiles.length, sql: sqlFiles.length },
  summary: { total: findings.length, critical, high, medium },
  findings,
  strengths,
}

const reportDir = path.join(ROOT, 'docs', 'security-audit')
fs.mkdirSync(reportDir, { recursive: true })
fs.writeFileSync(
  path.join(reportDir, 'last-audit.json'),
  `${JSON.stringify(report, null, 2)}\n`
)

if (JSON_ONLY) {
  console.log(JSON.stringify(report, null, 2))
}

const blocking = critical + high

if (STRICT && blocking > 0) {
  say(`\n${COLORS.CRITICAL} FALHOU ${COLORS.RESET} ${blocking} achado(s) bloqueante(s).\n`)
  process.exit(1)
}

say(
  blocking > 0
    ? `\n${COLORS.HIGH}Auditoria concluída com ${blocking} achado(s) para revisar.${COLORS.RESET}\n`
    : `\n${COLORS.OK}Auditoria limpa.${COLORS.RESET}\n`
)
