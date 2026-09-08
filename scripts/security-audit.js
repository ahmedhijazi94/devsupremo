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
const ts = require('typescript')

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
    .replace(
      /(^|[^:])\/\/[^\n]*/g,
      (m, p) => p + ' '.repeat(m.length - p.length),
    )
    .replace(/`(?:[^`\\]|\\.)*`/g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(
      /'(?:[^'\\\n]|\\.)*'/g,
      (m) => "'" + ' '.repeat(Math.max(0, m.length - 2)) + "'",
    )
    .replace(
      /"(?:[^"\\\n]|\\.)*"/g,
      (m) => '"' + ' '.repeat(Math.max(0, m.length - 2)) + '"',
    )
}

const tsFiles = collectFiles(path.join(ROOT, 'src'), ['.ts', '.tsx'])
  .concat(collectFiles(path.join(ROOT, 'app'), ['.ts', '.tsx']))
  .concat(collectFiles(path.join(ROOT, 'lib'), ['.ts', '.tsx']))
  .concat(collectFiles(path.join(ROOT, 'components'), ['.ts', '.tsx']))
  .concat(collectFiles(path.join(ROOT, 'actions'), ['.ts', '.tsx']))
  .filter((file) => !file.endsWith('.test.ts') && !file.endsWith('.test.tsx'))

const sqlFiles = collectFiles(path.join(ROOT, 'supabase'), ['.sql'])

// Tokenize comments and literal/function bodies before checking DDL. This is a
// bounded contract check for explicit table/FK/index declarations, not a SQL
// planner: complex DDL remains covered by the disposable database and RLS tests.
function sqlStatements(source) {
  let result = '', i = 0
  while (i < source.length) {
    const rest = source.slice(i)
    if (rest.startsWith('--')) { const end = source.indexOf('\n', i); i = end < 0 ? source.length : end; continue }
    if (rest.startsWith('/*')) {
      let depth = 1; i += 2
      while (i < source.length && depth) {
        if (source.slice(i, i + 2) === '/*') { depth++; i += 2 }
        else if (source.slice(i, i + 2) === '*/') { depth--; i += 2 }
        else i++
      }
      result += ' '; continue
    }
    const dollar = rest.match(/^\$(?:[a-z_][\w]*)?\$/i)?.[0]
    if (dollar || rest[0] === "'") {
      const delimiter = dollar || "'"
      i += delimiter.length
      while (i < source.length) {
        if (source.startsWith(delimiter, i)) {
          i += delimiter.length
          if (!dollar && source[i] === "'") { i++; continue }
          break
        }
        i++
      }
      result += "''"; continue
    }
    result += source[i++]
  }
  return result.split(';').map((statement) => statement.trim()).filter(Boolean)
}
function commaParts(body) {
  const parts = []; let depth = 0, start = 0
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '(') depth++
    if (body[i] === ')') depth--
    if (body[i] === ',' && depth === 0) { parts.push(body.slice(start, i).trim()); start = i + 1 }
  }
  parts.push(body.slice(start).trim())
  return parts
}
const normalTable = (name) => name.split('.').map((part) => part.startsWith('"') ? part.slice(1, -1) : part.toLowerCase()).join('.').replace(/^public\./, '')
const ddl = sqlFiles.filter((file) => file.includes(`${path.sep}migrations${path.sep}`)).sort()
  .flatMap((file) => sqlStatements(fs.readFileSync(file, 'utf8')).flatMap((statement) => {
    const alter = statement.match(/^(ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?[\w".]+\s+)([\s\S]+)$/i)
    return (alter ? commaParts(alter[2]).map((clause) => alter[1] + clause) : [statement]).map((statement) => ({ file, statement }))
  }))
const sqlContracts = new Map()
for (const { file, statement } of ddl) {
  const create = statement.match(/^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w".]+)\s*\(([\s\S]*)\)$/i)
  if (/^CREATE\s+(?:UNLOGGED\s+|TEMP(?:ORARY)?\s+)?TABLE\b/i.test(statement) && !create) {
    finding('HIGH', 'SQL_CONTRACT', rel(file), 1, statement.slice(0, 150),
      'DDL de tabela fora do contrato estático reconhecido. Exige suporte/prova explícita; não pode ser omitido silenciosamente da validação.')
  }
  const alter = statement.match(/^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?([\w".]+)\s+([\s\S]+)$/i)
  const index = statement.match(/^CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?[\w"]+\s+ON\s+([\w".]+)\s*(?:USING\s+\w+\s*)?\(([^)]+)\)\s*$/i)
  const drop = statement.match(/^DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([\w".]+)/i)
  if (drop) { sqlContracts.delete(normalTable(drop[1])); continue }
  const dropIndex = statement.match(/^DROP\s+INDEX\s+(?:IF\s+EXISTS\s+)?([\w".]+)/i)
  if (dropIndex) {
    for (const entry of sqlContracts.values()) entry.indexes = entry.indexes.filter((item) => item.name !== normalTable(dropIndex[1]))
    continue
  }
  const match = create || alter || index
  if (!match) continue
  const name = normalTable(match[1])
  const entry = sqlContracts.get(name) ?? { name, file, fks: [], indexes: [], rls: null, created: false }
  if (create) entry.created = true
  const dropConstraint = alter?.[2].match(/^DROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?([\w"]+)/i)
  if (dropConstraint) {
    const constraintName = normalTable(dropConstraint[1])
    entry.fks = entry.fks.filter((fk) => fk.name !== constraintName)
    entry.indexes = entry.indexes.filter((item) => item.name !== constraintName)
  }
  const dropColumn = alter?.[2].match(/^DROP\s+(?:COLUMN\s+)?(?:IF\s+EXISTS\s+)?"?(\w+)"?/i)
  if (dropColumn && !dropConstraint) {
    entry.fks = entry.fks.filter((fk) => !fk.columns.includes(dropColumn[1].toLowerCase()))
    entry.indexes = entry.indexes.filter((item) => !item.columns.includes(dropColumn[1].toLowerCase()))
  }
  const definitions = create ? commaParts(create[2]) : alter ? [alter[2].replace(/^ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?/i, '')] : []
  for (const definition of definitions) {
    const foreign = definition.match(/\bFOREIGN\s+KEY\s*\(([^)]+)\)\s+REFERENCES\b/i)
    const column = definition.match(/^"?(\w+)"?\s+/)?.[1]
    const columns = foreign ? foreign[1].replaceAll('"', '').split(',').map((col) => col.trim().toLowerCase())
      : /\bREFERENCES\b/i.test(definition) && column ? [column.toLowerCase()] : null
    if (columns) entry.fks.push({ name: normalTable(definition.match(/^CONSTRAINT\s+([\w"]+)/i)?.[1] ?? `${name}_${columns.join('_')}_fkey`), columns, explicitDelete: /\bON\s+DELETE\s+(?:CASCADE|RESTRICT|SET\s+NULL|SET\s+DEFAULT|NO\s+ACTION)\b/i.test(definition), file })
    const primary = definition.match(/\b(?:PRIMARY\s+KEY|UNIQUE)\s*\(([^)]+)\)/i)
    const constraintName = definition.match(/^CONSTRAINT\s+([\w"]+)/i)?.[1]
    if (primary) entry.indexes.push({ name: constraintName ? normalTable(constraintName) : `${name}_pkey`, columns: primary[1].replaceAll('"', '').split(',').map((col) => col.trim().toLowerCase()) })
    else if (column && /\b(?:PRIMARY\s+KEY|UNIQUE)\b/i.test(definition)) entry.indexes.push({ name: /PRIMARY/i.test(definition) ? `${name}_pkey` : `${name}_${column}_key`, columns: [column.toLowerCase()] })
  }
  if (index) entry.indexes.push({ name: normalTable(statement.match(/\bINDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w"]+)/i)[1]), columns: index[2].replaceAll('"', '').split(',').map((col) => col.trim().replace(/\s+(ASC|DESC).*$/i, '').toLowerCase()) })
  if (alter && /^(ENABLE|DISABLE)\s+ROW\s+LEVEL\s+SECURITY$/i.test(alter[2])) entry.rls = /^ENABLE/i.test(alter[2])
  sqlContracts.set(name, entry)
}
for (const entry of sqlContracts.values()) {
  if (entry.created && entry.rls !== true || entry.rls === false) finding('CRITICAL', 'SQL_CONTRACT', rel(entry.file), 1, entry.name,
    'O estado final das migrations não mantém RLS ativo. Preserve RLS e valide as policies no banco descartável; comentários não contam como DDL.')
  for (const fk of entry.fks) {
    if (!fk.explicitDelete) finding('HIGH', 'SQL_CONTRACT', rel(fk.file), 1, `${entry.name}(${fk.columns.join(',')})`,
      'Foreign key sem comportamento ON DELETE explícito. Defina o contrato de exclusão sem alterar dados existentes por rotina.')
    if (!entry.indexes.some(({ columns }) => fk.columns.every((column, i) => columns[i] === column))) {
      finding('HIGH', 'SQL_INDEX', rel(fk.file), 1, `${entry.name}(${fk.columns.join(',')})`,
        'Foreign key sem índice completo iniciado pelas colunas referenciadoras. Adicione uma migration forward-only com o índice; índices parciais não cobrem todas as linhas.')
    }
  }
}

say(`\n${COLORS.DIM}Supremo — auditoria de segurança${COLORS.RESET}`)
say(
  `${COLORS.DIM}${tsFiles.length} arquivos TypeScript · ${sqlFiles.length} migrations${COLORS.RESET}`,
)

// ═════════════════════════════════════════════════════════════
// 1. RLS
// ═════════════════════════════════════════════════════════════
section('1 · Row Level Security')

const tablesTotal = [...sqlContracts.values()].filter((entry) => entry.created).length
const tablesProtected = [...sqlContracts.values()].filter((entry) => entry.created && entry.rls === true).length

// Estado final das policies: uma correção forward-only deve poder remover uma
// policy antiga. Esta regra reconhece condições simples; não substitui testes RLS.
const finalPolicies = new Map()
for (const file of sqlFiles.filter((f) => f.includes(`${path.sep}migrations${path.sep}`)).sort()) {
  const source = fs.readFileSync(file, 'utf8').replace(/--[^\n]*|\/\*[\s\S]*?\*\//g,
    (match) => match.replace(/[^\n]/g, ' '))
  const statements = source.matchAll(/\b(CREATE|ALTER|DROP)\s+POLICY\s+(?:IF\s+EXISTS\s+)?("[^"]+"|\w+)\s+ON\s+((?:"?\w+"?\.)?"?\w+"?)([^;]*);/gi)
  for (const match of statements) {
    const table = match[3].replace(/"/g, '').replace(/^public\./i, '').toLowerCase()
    const key = `${table}:${match[2].replace(/"/g, '')}`
    if (match[1].toUpperCase() === 'DROP') { finalPolicies.delete(key); continue }
    const prior = finalPolicies.get(key)
    const body = match[4]
    const check = body.match(/WITH\s+CHECK\s*\(([\s\S]*)\)\s*$/i)?.[1]
    const using = body.match(/USING\s*\(([\s\S]*?)\)\s*(?:WITH\s+CHECK|$)/i)?.[1]
    finalPolicies.set(key, {
      table, file, line: source.slice(0, match.index).split('\n').length,
      command: body.match(/FOR\s+(ALL|INSERT|SELECT|UPDATE|DELETE)\b/i)?.[1]?.toUpperCase() ?? prior?.command ?? 'ALL',
      check: check ?? prior?.check, using: using ?? prior?.using,
      code: match[0],
    })
  }
}
// Exceção estreita: envio write-only demonstrado pelo schema, nunca por comentário
// no endpoint. DDL complexo não reconhecido continua sujeito à revisão de auth.
const publicSubmissionTables = new Set()
const migrationSql = sqlFiles.filter((f) => f.includes(`${path.sep}migrations${path.sep}`))
  .sort().map((file) => fs.readFileSync(file, 'utf8').replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, '')).join('\n')
for (const match of migrationSql.matchAll(/CREATE\s+TABLE\s+(?:public\.)?(\w+)\s*\(([^;]+)\)\s*;/gi)) {
  const table = match[1].toLowerCase()
  const body = match[2]
  if (/\b(?:references|user_id|owner_id|org_id|organization_id|team_id|workspace_id|account_id|tenant_id|company_id|group_id)\b/i.test(body)) continue
  const tablePattern = `(?:(?:public|"public")\\s*\\.\\s*)?"?${table}"?`
  const alters = [...migrationSql.matchAll(new RegExp(`ALTER\\s+TABLE\\s+${tablePattern}\\s+([^;]+);`, 'gi'))]
  if (!alters.some((alter) => /^ENABLE\s+ROW\s+LEVEL\s+SECURITY\s*$/i.test(alter[1]))) continue
  if (alters.some((alter) => !/^ENABLE\s+ROW\s+LEVEL\s+SECURITY\s*$/i.test(alter[1]))) continue
  const policies = [...finalPolicies.values()].filter((policy) => policy.table === table)
  if (policies.length && policies.every((policy) => policy.command === 'INSERT'
    && /^\s*true\s*$/i.test(policy.check ?? '') && !policy.using)) publicSubmissionTables.add(table)
}
for (const policy of finalPolicies.values()) {
  if (![policy.using, policy.check].some((condition) => /^\s*true\s*$/i.test(condition ?? ''))) continue
  if (publicSubmissionTables.has(policy.table) && policy.command === 'INSERT') continue
  finding('HIGH', 'RLS', rel(policy.file), policy.line, policy.code,
    `Policy irrestrita em "${policy.table}". Somente INSERT write-only sem ownership admite condição true; proteja dados privados por dono/escopo.`)
}

for (const policy of finalPolicies.values()) {
  if (!['ALL', 'INSERT'].includes(policy.command)) continue
  if (!/^(memberships|org_members|organization_members|team_members)$/.test(policy.table)) continue
  const condition = (policy.check ?? policy.using ?? '').replace(/\bSELECT\s+/gi, '').replace(/[\s()";]/g, '').toLowerCase()
  if (!['user_id=auth.uid', 'auth.uid=user_id', 'auth.uidisnotnull', 'true'].includes(condition)) continue
  finding('HIGH', 'RLS_MEMBERSHIP', rel(policy.file), policy.line, policy.code,
    'A policy permite autoassociação sem autorizar acesso à organização. Valide convite/permissão no servidor e teste adesão a um tenant alheio.')
}

if (tablesTotal > 0 && tablesProtected === tablesTotal) {
  strength(`RLS ativo nas ${tablesTotal} tabelas das migrations`)
}

// Importações estáticas de Client Components não podem alcançar credenciais
// privilegiadas. Server Actions explícitas são fronteiras RPC válidas.
const sourceByFile = new Map(tsFiles.map((file) => [file, fs.readFileSync(file, 'utf8')]))
const syntaxByFile = new Map([...sourceByFile].map(([file, content]) => [file,
  ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)]))
function visitNodes(root, predicate, skipNestedFunctions = false) {
  const matches = []
  function visit(node) {
    if (node !== root && skipNestedFunctions && ts.isFunctionLike(node)) return
    if (predicate(node)) matches.push(node)
    ts.forEachChild(node, visit)
  }
  visit(root)
  return matches
}
function methodName(call) {
  return ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text
    : ts.isIdentifier(call.expression) ? call.expression.text : null
}
function literal(node) {
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null
}
function hasDirective(node, directive) {
  return Boolean(node.statements?.some((statement) => ts.isExpressionStatement(statement) && literal(statement.expression) === directive))
}
function functionName(node) {
  return node.name?.getText() ?? (ts.isVariableDeclaration(node.parent) ? node.parent.name.getText() : '(ação inline)')
}
function executableEntries(file, syntax) {
  const serverModule = hasDirective(syntax, 'use server')
  const route = /[\\/]route\.tsx?$/.test(file)
  return visitNodes(syntax, (node) => {
    if (!ts.isFunctionLike(node) || !node.body) return false
    if (hasDirective(node.body, 'use server')) return true
    if (!serverModule && !route) return false
    if (node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) return true
    return ts.isVariableDeclaration(node.parent) && ts.isVariableDeclarationList(node.parent.parent)
      && node.parent.parent.parent.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
  })
}
// Query chains are real syntax nodes. Comments, strings containing example code,
// multiline calls and template interpolation do not erase the identifiers.
function queryChains(syntax) {
  return visitNodes(syntax, (node) => ts.isCallExpression(node) && methodName(node) === 'from')
    .map((start) => {
      const methods = [start]
      let end = start
      while (ts.isPropertyAccessExpression(end.parent) && end.parent.expression === end
        && ts.isCallExpression(end.parent.parent) && end.parent.parent.expression === end.parent) {
        end = end.parent.parent
        methods.push(end)
      }
      return { start, end, table: literal(start.arguments[0]), methods }
    })
}
function localImport(from, specifier) {
  const base = specifier.startsWith('.') ? path.resolve(path.dirname(from), specifier)
    : specifier.startsWith('@/') ? path.join(ROOT, fs.existsSync(path.join(ROOT, 'src')) ? 'src' : '', specifier.slice(2)) : null
  if (!base) return null
  return [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]
    .find((candidate) => sourceByFile.has(candidate))
}
for (const [entry] of sourceByFile) {
  if (!hasDirective(syntaxByFile.get(entry), 'use client')) continue
  const pending = [entry], seen = new Set()
  while (pending.length) {
    const file = pending.pop()
    if (seen.has(file)) continue
    seen.add(file)
    const syntax = syntaxByFile.get(file)
    if (file !== entry && hasDirective(syntax, 'use server')) continue
    const privileged = visitNodes(syntax, (node) =>
      (ts.isImportDeclaration(node) && literal(node.moduleSpecifier) === 'server-only') ||
      (ts.isPropertyAccessExpression(node) && node.expression.getText(syntax) === 'process.env'
        && !node.name.text.startsWith('NEXT_PUBLIC_') && node.name.text !== 'NODE_ENV') ||
      (ts.isElementAccessExpression(node) && node.expression.getText(syntax) === 'process.env'
        && !(literal(node.argumentExpression)?.startsWith('NEXT_PUBLIC_')))).length > 0
    if (privileged) {
      finding('CRITICAL', 'CLIENT_SERVER_BOUNDARY', rel(entry), 1, `Importação alcança ${rel(file)}`,
        'Um componente cliente alcança código privilegiado. Separe a operação em Server Action ou Route Handler com autorização no servidor.')
      break
    }
    const imports = visitNodes(syntax, (node) =>
      ((ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) || (ts.isExportDeclaration(node) && !node.isTypeOnly)) && node.moduleSpecifier
      || (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || methodName(node) === 'require')))
    for (const node of imports) {
      const specifier = literal(node.moduleSpecifier ?? node.arguments?.[0])
      if (!specifier) continue
      const resolved = localImport(file, specifier)
      if (resolved) pending.push(resolved)
    }
    // Mutations belong in a server entry point even when the browser SDK would
    // apply RLS. This is an enforceable boundary, not a claim about business logic.
    if (queryChains(syntax).some((chain) => chain.methods.some((call) => ['insert', 'update', 'delete', 'upsert'].includes(methodName(call))))) {
      finding('HIGH', 'CLIENT_MUTATION', rel(entry), 1, 'Mutação de dados no componente cliente',
        'Mova a mutação para Server Action/Route Handler, validando entradas e permissões no servidor.')
    }
  }
}

// Service role nunca pode alcançar o bundle do cliente.
for (const file of tsFiles) {
  const source = fs.readFileSync(file, 'utf8')
  if (!source.includes('SUPABASE_SERVICE_ROLE_KEY')) continue

  const lines = source.split('\n')
  const isClient = /^\s*['"]use client['"]/m.test(source)

  if (isClient) {
    const lineNumber =
      lines.findIndex((l) => l.includes('SUPABASE_SERVICE_ROLE_KEY')) + 1
    finding(
      'CRITICAL',
      'RLS',
      rel(file),
      lineNumber,
      lines[lineNumber - 1] ?? '',
      'Service role key referenciada em Client Component. Ela ignora RLS e ' +
        'iria para o bundle do navegador.',
    )
  }
}

// ═════════════════════════════════════════════════════════════
// 2. Autorização
// ═════════════════════════════════════════════════════════════
section('2 · Autorização em Server Actions e Route Handlers')

// Per-entry analysis: another function's getUser(), a comment, or a nested
// unused helper cannot authorize this entry point. Static analysis recognizes
// explicit guards; executable negative tests remain the authorization proof.
const THROWING_GUARDS = new Set(['requireUser', 'requireProjectOwner'])
const SESSION_CALLS = new Set(['getUser', 'authenticateDeviceSecret', 'resolveMcpToken'])
function localGuard(syntax, name, seen = new Set()) {
  if (!name || seen.has(name)) return false
  seen.add(name)
  const target = syntax.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name)
  if (!target?.body) return false
  const calls = visitNodes(target.body, ts.isCallExpression, true)
  const dataPosition = Math.min(...calls.filter((call) => ['from', 'rpc'].includes(methodName(call))).map((call) => call.pos), Infinity)
  return calls.some((call) => call.pos < dataPosition &&
    (THROWING_GUARDS.has(methodName(call)) || localGuard(syntax, methodName(call), seen)))
}
let guardedActions = 0
for (const [file, syntax] of syntaxByFile) {
  for (const entry of executableEntries(file, syntax)) {
    const calls = visitNodes(entry.body, ts.isCallExpression, true)
    const dataCalls = calls.filter((call) => ['from', 'rpc'].includes(methodName(call))
      || (ts.isPropertyAccessExpression(call.expression) && /\.storage\b/.test(call.expression.getText(syntax))))
    if (!dataCalls.length) continue
    const firstData = Math.min(...dataCalls.map((call) => call.getStart(syntax)))
    const preceding = calls.filter((call) => call.getStart(syntax) < firstData)
    const guards = preceding.filter((call) => THROWING_GUARDS.has(methodName(call)) || localGuard(syntax, methodName(call)))
    const sessionChecks = preceding.filter((call) => SESSION_CALLS.has(methodName(call)))
    const denial = visitNodes(entry.body, (node) => ts.isIfStatement(node)
      && node.getStart(syntax) < firstData
      && visitNodes(node.thenStatement, (branch) => ts.isReturnStatement(branch) || ts.isThrowStatement(branch)
        || ts.isCallExpression(branch) && methodName(branch) === 'redirect').length > 0, true)
    const conditionalIdentity = dataCalls.every((call) => {
      let parent = call.parent
      while (parent && parent !== entry) {
        if (ts.isIfStatement(parent) && /^(?:user|session\.user)(?:\s*&&|$)/.test(parent.expression.getText(syntax))
          && parent.thenStatement.pos <= call.pos && parent.thenStatement.end >= call.end) return true
        parent = parent.parent
      }
      return false
    })
    const authenticated = guards.length > 0 || (sessionChecks.length > 0 && (denial.length > 0 || conditionalIdentity))
    const chains = queryChains(entry.body)
    const publicWriteOnly = chains.length > 0 && chains.every((chain) => publicSubmissionTables.has(chain.table?.toLowerCase())
      && chain.methods.some((call) => methodName(call) === 'insert')
      && !chain.methods.some((call) => ['select', 'update', 'delete', 'upsert', 'rpc'].includes(methodName(call))))
      && !calls.some((call) => methodName(call) === 'rpc' || /(?:Admin|Service)Client/.test(methodName(call) ?? ''))
      && !/service_role|serviceRole|SUPABASE_SERVICE_ROLE_KEY/.test(entry.body.getText(syntax))
    if (!authenticated && !publicWriteOnly) {
      finding('CRITICAL', 'AUTHZ', rel(file), syntax.getLineAndCharacterOfPosition(entry.getStart(syntax)).line + 1,
        functionName(entry), 'Esta operação acessa dados sem guard de identidade e negação de acesso reconhecidos antes do I/O. Outra função do arquivo não autoriza esta entrada; preserve provas executáveis de acesso negado.')
    } else if (authenticated) guardedActions++
    const mutations = calls.filter((call) => ['insert', 'update', 'upsert', 'delete', 'rpc'].includes(methodName(call)))
    const validators = preceding.filter((call) => ['parse', 'safeParse', 'parseAsync', 'safeParseAsync'].includes(methodName(call)))
    const rawParameters = new Set(entry.parameters.filter((param) => ts.isIdentifier(param.name)).map((param) => param.name.text))
    const rawInputReachesQuery = chains.some((chain) => visitNodes(chain.end, (node) => ts.isIdentifier(node)
      && rawParameters.has(node.text) && !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)).length > 0)
    if (mutations.length && rawInputReachesQuery && !validators.length) {
      finding('HIGH', 'SERVER_INPUT', rel(file), syntax.getLineAndCharacterOfPosition(entry.getStart(syntax)).line + 1,
        functionName(entry), 'A mutação recebe parâmetros sem validação de entrada reconhecida antes do I/O. Valide com schema no servidor e use o resultado validado.')
    }
  }
}
if (guardedActions > 0) strength(`${guardedActions} entrada(s) com guard local reconhecido; autorização efetiva exige testes negativos`)

// ═════════════════════════════════════════════════════════════
// 3. IDOR — syntax, never code examples inside comments/strings
// ═════════════════════════════════════════════════════════════
section('3 · IDOR — objeto acessado por ID sem escopo')
const SCOPE_COLUMNS = new Set(['user_id', 'owner_id', 'owner_user_id', 'org_id', 'organization_id',
  'team_id', 'workspace_id', 'account_id', 'tenant_id', 'project_id', 'device_id', 'user_code', 'device_code_hash'])
let ownershipChecked = 0
for (const [file, syntax] of syntaxByFile) {
  for (const chain of queryChains(syntax)) {
    const byId = chain.methods.some((call) => methodName(call) === 'eq' && literal(call.arguments[0]) === 'id')
    const changesRows = chain.methods.some((call) => ['update', 'delete', 'upsert'].includes(methodName(call)))
    if (!byId && !changesRows) continue
    const scoped = chain.methods.some((call) =>
      ['eq', 'in'].includes(methodName(call)) && SCOPE_COLUMNS.has(literal(call.arguments[0]))
      || (methodName(call) === 'match' && ts.isObjectLiteralExpression(call.arguments[0]) && call.arguments[0].properties.some((prop) => SCOPE_COLUMNS.has(prop.name?.getText(syntax).replace(/['"]/g, '')))))
    if (scoped) { ownershipChecked++; continue }
    // The row itself can be the authenticated user's profile. Equality with a
    // literal ID or arbitrary request parameter does not meet this exception.
    const ownProfile = chain.table === 'profiles' && chain.methods.some((call) => methodName(call) === 'eq'
      && literal(call.arguments[0]) === 'id' && /^(?:user|session\.user)\.id$/.test(call.arguments[1]?.getText(syntax) ?? ''))
    if (ownProfile) { ownershipChecked++; continue }
    const ownUpsert = chain.methods.some((call) => methodName(call) === 'upsert' && call.arguments[0]
      && ts.isObjectLiteralExpression(call.arguments[0]) && call.arguments[0].properties.some((property) =>
        ts.isPropertyAssignment(property) && SCOPE_COLUMNS.has(property.name.getText(syntax).replace(/['"]/g, ''))
        && /^(?:user|session\.user)\.id$/.test(property.initializer.getText(syntax))
        && call.arguments[1] && ts.isObjectLiteralExpression(call.arguments[1]) && call.arguments[1].properties.some((option) =>
          ts.isPropertyAssignment(option) && option.name.getText(syntax) === 'onConflict'
          && literal(option.initializer)?.split(',').map((key) => key.trim()).includes(property.name.getText(syntax).replace(/['"]/g, '')))))
    if (ownUpsert) { ownershipChecked++; continue }
    const exposed = executableEntries(file, syntax).some((entry) => entry.pos <= chain.start.pos && entry.end >= chain.end.end)
    // Internal privileged adapters can receive already-authorized capabilities.
    // Report uncertainty explicitly instead of claiming a proven vulnerability
    // or silently exempting a filename. Exposed mutations always fail closed.
    finding(exposed && changesRows ? 'HIGH' : 'MEDIUM', 'IDOR', rel(file), syntax.getLineAndCharacterOfPosition(chain.start.getStart(syntax)).line + 1,
      chain.end.getText(syntax), `Query em "${chain.table ?? '(tabela dinâmica)'}" sem filtro explícito de dono/escopo. ${exposed && changesRows ? 'A mutação exposta deve limitar a operação por identidade/escopo.' : 'A autorização do chamador não foi provada pela análise local; exige revisão/prova executável.'} Nome de arquivo repository.ts não é autorização.`)
  }
}
if (ownershipChecked > 0) strength(`${ownershipChecked} query(s) com filtro explícito de escopo; a origem do escopo exige prova de autorização`)

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
  {
    name: 'Chave privada',
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  },
  { name: 'JWT', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\./ },
]

/** Placeholder de documentação não é segredo. */
const PLACEHOLDER =
  /(your|seu|my|example|placeholder|xxx|\.\.\.|<[^>]+>|dummy|fake|test|sample)/i

let secretsFound = 0

for (const file of tsFiles.concat(
  collectFiles(ROOT, ['.json', '.yml', '.yaml']),
)) {
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
          `revogue a credencial — ela já está no histórico do git.`,
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
    ['.env', '.env*', '.env.local', '*.local', '.env.*'].includes(p),
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
      'Nenhum padrão cobrindo .env. Adicione a linha: .env*',
    )
  }
} else {
  finding(
    'HIGH',
    'SECRET',
    '.gitignore',
    1,
    '(ausente)',
    'Projeto sem .gitignore.',
  )
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
  /from\s+['"]zod['"]/.test(fs.readFileSync(file, 'utf8')),
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
  `${JSON.stringify(report, null, 2)}\n`,
)

if (JSON_ONLY) {
  console.log(JSON.stringify(report, null, 2))
}

const blocking = critical + high

if (STRICT && blocking > 0) {
  say(
    `\n${COLORS.CRITICAL} FALHOU ${COLORS.RESET} ${blocking} achado(s) bloqueante(s).\n`,
  )
  process.exit(1)
}

say(
  blocking > 0
    ? `\n${COLORS.HIGH}Auditoria concluída com ${blocking} achado(s) para revisar.${COLORS.RESET}\n`
    : findings.length > 0
      ? `\n${COLORS.MEDIUM}Sem achados CRITICAL/HIGH; ${findings.length} achado(s) adicionais exigem revisão.${COLORS.RESET}\n`
      : `\n${COLORS.OK}Auditoria sem achados.${COLORS.RESET}\n`,
)
