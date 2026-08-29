#!/usr/bin/env node
/**
 * SUPREMO SECURITY AUDIT SCRIPT
 * Roda todos os checks de segurança sem gastar tokens de IA.
 * Categorias: RLS, Permission Leak, IDOR, Hardcoded Secrets, XSS
 *
 * Uso: node scripts/security-audit.js [--strict]
 * --strict: falha com exit 1 se houver qualquer achado crítico ou alto
 */

const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..')
const args = process.argv.slice(2)
const STRICT = args.includes('--strict')

const SEVERITY = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, INFO: 4 }
const COLORS = {
  CRITICAL: '\x1b[41m\x1b[37m',
  HIGH: '\x1b[31m',
  MEDIUM: '\x1b[33m',
  LOW: '\x1b[34m',
  INFO: '\x1b[32m',
  RESET: '\x1b[0m',
}

const findings = []
const strengths = []

function finding(severity, category, file, line, code, reason) {
  findings.push({ severity, category, file, line, code, reason })
  const col = COLORS[severity] ?? COLORS.RESET
  console.log(`${col}[${severity}][${category}] ${file}:${line}${COLORS.RESET}`)
  console.log(`  Code: ${code.trim()}`)
  console.log(`  Why:  ${reason}\n`)
}

function strength(msg) {
  strengths.push(msg)
  console.log(`${COLORS.INFO}[✓ OK] ${msg}${COLORS.RESET}`)
}

// ─── Collect all source files ───────────────────────────────────────────────
function collectFiles(dir, exts, ignore = ['node_modules', '.next', 'dist', '.git']) {
  const results = []
  if (!fs.existsSync(dir)) return results
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ignore.some(ig => entry.name === ig)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      results.push(...collectFiles(full, exts, ignore))
    } else if (exts.some(e => entry.name.endsWith(e))) {
      results.push(full)
    }
  }
  return results
}

function readLines(file) {
  return fs.readFileSync(file, 'utf8').split('\n')
}

function rel(file) {
  return path.relative(ROOT, file)
}

// ═══════════════════════════════════════════════════════════════════════════
// CAT 1: BANCO SEM TRANCA (RLS / Tenant Isolation)
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
console.log('CAT 1: BANCO SEM TRANCA (RLS / Tenant Isolation)')
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')

// Check migration files for tables without RLS
const sqlFiles = collectFiles(ROOT, ['.sql'])
let tablesFound = 0
let tablesWithRLS = 0

for (const file of sqlFiles) {
  const content = fs.readFileSync(file, 'utf8')
  const tableMatches = [...content.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?["']?(\w+)["']?/gi)]

  for (const match of tableMatches) {
    tablesFound++
    const tableName = match[1]
    const hasRLS = content.includes(`ALTER TABLE ${tableName} ENABLE ROW LEVEL SECURITY`) ||
                   content.includes(`ALTER TABLE "${tableName}" ENABLE ROW LEVEL SECURITY`)

    if (!hasRLS) {
      finding('CRITICAL', 'RLS', rel(file), content.split('\n').findIndex(l => l.includes(match[0])) + 1,
        match[0], `Table "${tableName}" has no RLS policy. Any authenticated user can read/write all rows.`)
    } else {
      tablesWithRLS++
    }
  }
}

if (tablesFound > 0 && tablesWithRLS === tablesFound) {
  strength(`All ${tablesFound} tables have RLS enabled`)
}

// Check for Supabase queries without user filter in server actions/routes
const tsFiles = collectFiles(path.join(ROOT, 'src'), ['.ts', '.tsx'])
const rlsRiskyPatterns = [
  { pattern: /\.from\(['"]\w+['"]\)\s*\n?\s*\.select\((?!.*\.eq\()/gm, desc: '.select() without .eq() filter — possible data leak across users' },
]

for (const file of tsFiles) {
  // Skip client-side files and type files
  if (file.includes('components') && !file.includes('actions')) continue
  if (file.includes('types/')) continue

  const content = fs.readFileSync(file, 'utf8')
  const lines = content.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    // Check for .from().select() without .eq('user_id') or .eq('id') nearby
    if (line.match(/\.from\(['"\w]+['"]\)/) && lines[i+1]?.includes('.select(')) {
      const next3 = lines.slice(i, i+6).join('\n')
      if (!next3.includes('.eq(') && !next3.includes('.single(') && !next3.includes('user_id') && !next3.includes('auth.uid()')) {
        // Only flag server-side files (actions, api routes)
        if (file.includes('actions/') || file.includes('route.ts') || file.includes('route.tsx')) {
          finding('HIGH', 'RLS', rel(file), i + 1, line,
            'Supabase query without explicit user filter. If RLS is bypassed (service role), this leaks all rows.')
        }
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// CAT 2: PERMISSÃO DEFINIDA NO NAVEGADOR (Frontend-only auth gates)
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
console.log('CAT 2: PERMISSÃO DEFINIDA NO NAVEGADOR')
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')

const frontendGatePatterns = [
  { regex: /isAdmin\s*&&/g, label: 'isAdmin gate' },
  { regex: /canEdit\s*&&/g, label: 'canEdit gate' },
  { regex: /role\s*===\s*['"]admin['"]/g, label: 'role===admin check' },
  { regex: /user\.role\s*===\s*['"]/g, label: 'user.role check in frontend' },
  { regex: /if\s*\(\s*!isAdmin\s*\)/g, label: '!isAdmin gate' },
]

const clientFiles = tsFiles.filter(f => {
  const content = fs.readFileSync(f, 'utf8')
  return content.startsWith("'use client'") || content.startsWith('"use client"')
})

let frontendGatesFound = 0

for (const file of clientFiles) {
  const content = fs.readFileSync(file, 'utf8')
  const lines = content.split('\n')

  for (const { regex, label } of frontendGatePatterns) {
    let match
    const re = new RegExp(regex.source, 'gm')
    while ((match = re.exec(content)) !== null) {
      const lineNum = content.substring(0, match.index).split('\n').length
      frontendGatesFound++
      finding('HIGH', 'FRONTEND_GATE', rel(file), lineNum, lines[lineNum - 1] ?? '',
        `"${label}" found in client component. If the backend endpoint doesn't verify this, any user can bypass.`)
    }
  }
}

if (frontendGatesFound === 0) {
  strength('No frontend-only permission gates detected in client components')
}

// Check server actions DO verify auth
let actionsWithAuth = 0
let actionsWithoutAuth = 0
const actionFiles = tsFiles.filter(f => f.includes('actions/') || (f.includes('route.ts') && !f.includes('callback')))

for (const file of actionFiles) {
  const content = fs.readFileSync(file, 'utf8')
  if (!content.includes('export async function') && !content.includes('export function')) continue

  const hasAuthCheck = content.includes('getUser()') || content.includes('auth.getSession()') || content.includes('supabase.auth')
  if (hasAuthCheck) {
    actionsWithAuth++
  } else {
    actionsWithoutAuth++
    finding('CRITICAL', 'FRONTEND_GATE', rel(file), 1, 'export async function...',
      'Server Action/Route Handler has no authentication check. Unauthenticated users can call this.')
  }
}

if (actionsWithoutAuth === 0 && actionsWithAuth > 0) {
  strength(`All ${actionsWithAuth} server actions verify authentication`)
}

// ═══════════════════════════════════════════════════════════════════════════
// CAT 3: IDOR (Insecure Direct Object Reference)
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
console.log('CAT 3: IDOR — Referência Direta a Objetos')
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')

let idorRisksFound = 0

for (const file of actionFiles) {
  const content = fs.readFileSync(file, 'utf8')
  const lines = content.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''

    // Pattern: .eq('id', someId) without .eq('user_id', user.id) nearby
    if (line.match(/\.eq\(['"]id['"],\s*\w+\)/) || line.match(/\.eq\(['"]id['"],\s*formData\./)) {
      const surrounding = lines.slice(Math.max(0, i - 5), i + 5).join('\n')
      const hasOwnerCheck = surrounding.includes('user_id') || surrounding.includes('user.id') ||
                            surrounding.includes('auth.uid') || surrounding.includes('.eq(\'user_id\'')

      if (!hasOwnerCheck) {
        idorRisksFound++
        finding('HIGH', 'IDOR', rel(file), i + 1, line,
          'Query filters by ID but does NOT verify ownership (.eq("user_id", user.id)). Any user can access any object by ID.')
      }
    }

    // Pattern: DELETE/UPDATE without ownership check
    if ((line.includes('.delete()') || line.includes('.update(')) &&
        !line.includes('user_id')) {
      const surrounding = lines.slice(Math.max(0, i - 8), i + 2).join('\n')
      if (!surrounding.includes('user_id') && !surrounding.includes('user.id')) {
        idorRisksFound++
        finding('HIGH', 'IDOR', rel(file), i + 1, line,
          '.delete()/.update() without user_id filter. An attacker can delete/update any row by ID.')
      }
    }
  }
}

if (idorRisksFound === 0) {
  strength('No IDOR patterns detected — all mutations include ownership checks')
}

// ═══════════════════════════════════════════════════════════════════════════
// CAT 4: CHAVES EXPOSTAS (Hardcoded Secrets)
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
console.log('CAT 4: CHAVES EXPOSTAS (Hardcoded Secrets)')
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')

const secretPatterns = [
  { regex: /(?:sk|pk)_(?:live|test)_[a-zA-Z0-9]{20,}/g, label: 'Stripe key' },
  { regex: /eyJhbGciOi[a-zA-Z0-9._-]{20,}/g, label: 'JWT token (hardcoded)' },
  { regex: /(?:password|passwd|pwd)\s*[:=]\s*['"][^'"]{8,}['"]/gi, label: 'Hardcoded password' },
  { regex: /(?:secret|api_key|apikey|api-key)\s*[:=]\s*['"][^'"${\s]{8,}['"]/gi, label: 'Hardcoded secret/API key' },
  { regex: /AAAA[a-zA-Z0-9+/]{40,}/g, label: 'Possible SSH/RSA key' },
  { regex: /ghp_[a-zA-Z0-9]{36}/g, label: 'GitHub Personal Access Token' },
  { regex: /sbp_[a-zA-Z0-9]{40}/g, label: 'Supabase Personal Access Token' },
  { regex: /GOCSPX-[a-zA-Z0-9_-]{28}/g, label: 'Google OAuth Client Secret' },
  { regex: /xox[baprs]-[a-zA-Z0-9-]{10,}/g, label: 'Slack token' },
  { regex: /AIza[0-9A-Za-z-_]{35}/g, label: 'Google API key' },
]

const allFiles = collectFiles(ROOT, ['.ts', '.tsx', '.js', '.jsx', '.json', '.yml', '.yaml', '.env', '.sh', '.md'], ['node_modules', '.next', 'dist', '.git'])

let secretsFound = 0
const envExamplePath = path.join(ROOT, '.env.example')
const dotEnvLocalPath = path.join(ROOT, '.env.local')

for (const file of allFiles) {
  // Skip .env.local (legit credentials), .env.example (placeholders), and this script
  const relFile = rel(file)
  if (relFile.includes('.env.local') || relFile.endsWith('.env.example') || relFile.includes('security-audit')) continue

  const content = fs.readFileSync(file, 'utf8')
  const lines = content.split('\n')

  for (const { regex, label } of secretPatterns) {
    let match
    const re = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g')
    while ((match = re.exec(content)) !== null) {
      const lineNum = content.substring(0, match.index).split('\n').length
      secretsFound++
      finding('CRITICAL', 'HARDCODED_SECRET', relFile, lineNum, lines[lineNum - 1] ?? '',
        `${label} detected in source code. Rotate immediately and move to environment variable.`)
    }
  }
}

// Check .env.local is in .gitignore
const gitignorePath = path.join(ROOT, '.gitignore')
if (fs.existsSync(gitignorePath)) {
  const gi = fs.readFileSync(gitignorePath, 'utf8')
  if (gi.includes('.env.local') || gi.includes('.env*.local')) {
    strength('.env.local is in .gitignore — credentials not tracked by git')
  } else {
    finding('CRITICAL', 'HARDCODED_SECRET', '.gitignore', 1, '',
      '.env.local is NOT in .gitignore. Real credentials might be committed to git history.')
  }
} else {
  finding('HIGH', 'HARDCODED_SECRET', '(project root)', 0, '', 'No .gitignore found. Risk of committing .env files.')
}

if (secretsFound === 0) {
  strength('No hardcoded secrets detected in source files')
}

// Check for ENCRYPTION_KEY validation at startup
const hasEncryptionKeyValidation = tsFiles.some(f => {
  const c = fs.readFileSync(f, 'utf8')
  return c.includes('ENCRYPTION_KEY') && (c.includes('throw') || c.includes('Error'))
})
if (hasEncryptionKeyValidation) {
  strength('ENCRYPTION_KEY validated at startup — prevents running with insecure defaults')
}

// ═══════════════════════════════════════════════════════════════════════════
// CAT 5: INPUTS SEM TRATAMENTO (XSS)
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
console.log('CAT 5: INPUTS SEM TRATAMENTO (XSS)')
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')

const xssPatterns = [
  { regex: /dangerouslySetInnerHTML\s*=\s*\{\s*\{/g, label: 'dangerouslySetInnerHTML' },
  { regex: /innerHTML\s*=/g, label: 'innerHTML assignment' },
  { regex: /eval\s*\(/g, label: 'eval()' },
  { regex: /new\s+Function\s*\(/g, label: 'new Function()' },
  { regex: /href\s*=\s*\{[^}]*user|href\s*=\s*\{[^}]*input|href\s*=\s*\{[^}]*param/g, label: 'User-controlled href' },
  { regex: /v-html\s*=/g, label: 'Vue v-html' },
  { regex: /\[innerHTML\]\s*=/g, label: 'Angular [innerHTML]' },
]

let xssFound = 0

for (const file of tsFiles) {
  const content = fs.readFileSync(file, 'utf8')
  const lines = content.split('\n')

  for (const { regex, label } of xssPatterns) {
    let match
    const re = new RegExp(regex.source, 'gm')
    while ((match = re.exec(content)) !== null) {
      const lineNum = content.substring(0, match.index).split('\n').length
      const surrounding = lines.slice(Math.max(0, lineNum - 3), lineNum + 3).join('\n')

      // Skip if sanitized nearby
      const isSanitized = surrounding.includes('DOMPurify') || surrounding.includes('sanitize') ||
                          surrounding.includes('escapeHtml') || surrounding.includes('xss')

      if (!isSanitized) {
        xssFound++
        finding('HIGH', 'XSS', rel(file), lineNum, lines[lineNum - 1] ?? '',
          `${label} without sanitization. If content comes from user input, this is XSS.`)
      }
    }
  }
}

// Check if Zod is used for input validation
const hasZod = tsFiles.some(f => fs.readFileSync(f, 'utf8').includes("from 'zod'"))
if (hasZod) {
  strength('Zod is used for server-side input validation')
}

if (xssFound === 0) {
  strength('No XSS vectors (dangerouslySetInnerHTML, innerHTML, eval) detected')
}

// ═══════════════════════════════════════════════════════════════════════════
// BONUS: npm audit for dependency vulnerabilities
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
console.log('BONUS: Dependency Vulnerabilities (npm audit)')
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')

try {
  const auditOutput = execSync('npm audit --json 2>/dev/null', { cwd: ROOT }).toString()
  const audit = JSON.parse(auditOutput)
  const vulns = audit.metadata?.vulnerabilities ?? {}

  if ((vulns.critical ?? 0) > 0) {
    finding('CRITICAL', 'DEPENDENCY', 'package.json', 0, '',
      `npm audit: ${vulns.critical} critical vulnerabilities in dependencies. Run "npm audit fix".`)
  } else if ((vulns.high ?? 0) > 0) {
    finding('HIGH', 'DEPENDENCY', 'package.json', 0, '',
      `npm audit: ${vulns.high} high vulnerabilities. Run "npm audit".`)
  } else {
    strength(`npm audit: No critical/high vulnerabilities (${vulns.moderate ?? 0} moderate, ${vulns.low ?? 0} low)`)
  }
} catch {
  console.log('npm audit: skipped (no package.json or audit failed)\n')
}

// ═══════════════════════════════════════════════════════════════════════════
// REPORT SUMMARY
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n' + '═'.repeat(60))
console.log('SECURITY AUDIT SUMMARY')
console.log('═'.repeat(60))

const bySeverity = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 }
for (const f of findings) bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1

console.log(`\nTotal findings: ${findings.length}`)
console.log(`  ${COLORS.CRITICAL}CRITICAL: ${bySeverity.CRITICAL}${COLORS.RESET}`)
console.log(`  ${COLORS.HIGH}HIGH:     ${bySeverity.HIGH}${COLORS.RESET}`)
console.log(`  ${COLORS.MEDIUM}MEDIUM:   ${bySeverity.MEDIUM}${COLORS.RESET}`)
console.log(`  ${COLORS.LOW}LOW:      ${bySeverity.LOW}${COLORS.RESET}`)
console.log(`\nStrengths confirmed: ${strengths.length}`)

// Save JSON report
const reportDir = path.join(ROOT, 'docs', 'security-audit')
fs.mkdirSync(reportDir, { recursive: true })
const report = {
  timestamp: new Date().toISOString(),
  summary: bySeverity,
  strengths,
  findings,
}
fs.writeFileSync(path.join(reportDir, 'last-audit.json'), JSON.stringify(report, null, 2))
console.log(`\nFull report saved to: docs/security-audit/last-audit.json`)

if (STRICT && (bySeverity.CRITICAL > 0 || bySeverity.HIGH > 0)) {
  console.log(`\n${COLORS.CRITICAL}AUDIT FAILED — ${bySeverity.CRITICAL} critical, ${bySeverity.HIGH} high findings. Fix before committing.${COLORS.RESET}\n`)
  process.exit(1)
} else if (findings.length === 0) {
  console.log(`\n${COLORS.INFO}✅ AUDIT PASSED — No security issues found!${COLORS.RESET}\n`)
} else {
  console.log(`\n${COLORS.MEDIUM}⚠ AUDIT COMPLETE — Review findings above.${COLORS.RESET}\n`)
}
