export interface ForeignKeySqlToken {
  kind: 'word' | 'identifier' | 'literal' | 'body' | 'symbol'
  value: string
  start: number
  end: number
}

function malformed(): never {
  throw new Error('Migration recusada: sintaxe SQL incompleta no contrato de foreign keys. Nenhuma alteração foi aplicada.')
}

/** A restricted lexical view of migration SQL, not a PostgreSQL parser.
 * Comments and literal/function bodies can never supply SQL keywords. Positions
 * refer to the original SQL so callers never have to execute a rewritten view.
 */
export function tokenizeForeignKeySql(sql: string): ForeignKeySqlToken[] {
  const tokens: ForeignKeySqlToken[] = []
  let i = 0
  while (i < sql.length) {
    if (/\s/.test(sql[i]!)) { i++; continue }
    if (sql.startsWith('--', i)) {
      const end = sql.indexOf('\n', i)
      i = end < 0 ? sql.length : end + 1
      continue
    }
    if (sql.startsWith('/*', i)) {
      let depth = 1
      i += 2
      while (i < sql.length && depth > 0) {
        if (sql.startsWith('/*', i)) { depth++; i += 2 }
        else if (sql.startsWith('*/', i)) { depth--; i += 2 }
        else i++
      }
      if (depth !== 0) malformed()
      continue
    }
    const start = i
    const quote = sql[i]
    if (quote === "'" || quote === '"') {
      // Backslashes escape quotes only in E'...' strings, never in identifiers.
      const escaped = quote === "'" && /[eE]/.test(sql[i - 1] ?? '') &&
        (i === 1 || !/[\w$]/.test(sql[i - 2]!))
      i++
      let closed = false
      let value = ''
      while (i < sql.length) {
        if (escaped && sql[i] === '\\') {
          if (i + 1 >= sql.length) malformed()
          value += sql.slice(i, i + 2)
          i += 2
        } else if (sql[i] === quote) {
          if (sql[i + 1] === quote) { value += quote; i += 2 }
          else { i++; closed = true; break }
        } else value += sql[i++]
      }
      if (!closed) malformed()
      tokens.push({ kind: quote === '"' ? 'identifier' : 'literal', value, start, end: i })
      continue
    }
    const marker = /^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/.exec(sql.slice(i))?.[0]
    if (marker) {
      const bodyStart = i + marker.length
      const end = sql.indexOf(marker, bodyStart)
      if (end < 0) malformed()
      i = end + marker.length
      tokens.push({ kind: 'body', value: sql.slice(bodyStart, end), start, end: i })
      continue
    }
    const word = /^[A-Za-z_][A-Za-z_0-9$]*/.exec(sql.slice(i))?.[0]
    i += word?.length ?? 1
    tokens.push({ kind: word ? 'word' : 'symbol', value: sql.slice(start, i).toLowerCase(), start, end: i })
  }
  return tokens
}

const wordIs = (token: ForeignKeySqlToken | undefined, value: string): boolean =>
  token?.kind === 'word' && token.value === value

function inspectTableStatement(tokens: ForeignKeySqlToken[]): void {
  if (!(wordIs(tokens[0], 'create') || wordIs(tokens[0], 'alter'))) return
  let tableIndex = 1
  if (wordIs(tokens[tableIndex], 'temporary') || wordIs(tokens[tableIndex], 'temp') || wordIs(tokens[tableIndex], 'unlogged')) tableIndex++
  if (!wordIs(tokens[tableIndex], 'table')) return

  let depth = 0
  for (let i = tableIndex + 1; i < tokens.length; i++) {
    const token = tokens[i]!
    if (token.kind === 'symbol' && token.value === '(') depth++
    if (token.kind === 'symbol' && token.value === ')') depth--
    if (depth < 0) malformed()
    if (!wordIs(token, 'references')) continue

    let cursorDepth = depth
    let explicit = false
    for (let j = i + 1; j < tokens.length; j++) {
      const current = tokens[j]!
      if (current.kind === 'symbol') {
        if (current.value === '(') cursorDepth++
        if (current.value === ')') cursorDepth--
        if (cursorDepth < depth || (current.value === ',' && cursorDepth === depth)) break
      }
      if (cursorDepth !== depth) continue
      // An action belonging to a later reference cannot validate this one.
      if (wordIs(current, 'references')) break
      if (!wordIs(current, 'on') || !wordIs(tokens[j + 1], 'delete')) continue
      const action = tokens[j + 2]
      explicit = wordIs(action, 'cascade') || wordIs(action, 'restrict') ||
        (wordIs(action, 'no') && wordIs(tokens[j + 3], 'action')) ||
        (wordIs(action, 'set') && (wordIs(tokens[j + 3], 'null') || wordIs(tokens[j + 3], 'default')))
      if (explicit) break
    }
    if (!explicit) {
      throw new Error('Migration recusada: toda foreign key nova precisa declarar ON DELETE explicitamente antes da aplicação. Use ON DELETE NO ACTION para manter o comportamento padrão, ou defina a regra de exclusão adequada. Nenhuma alteração foi aplicada.')
    }
  }
  if (depth !== 0) malformed()
}

/** Reject omissions before a migration changes the database. This complements
 * the full-history audit; it neither rewrites SQL nor exempts earlier failures.
 * Destructive operations and RLS remain independently checked by the policy.
 */
export function assertExplicitForeignKeyDelete(sql: string): void {
  let statement: ForeignKeySqlToken[] = []
  for (const token of tokenizeForeignKeySql(sql)) {
    if (token.kind === 'symbol' && token.value === ';') {
      inspectTableStatement(statement)
      statement = []
    } else statement.push(token)
  }
  inspectTableStatement(statement)
}
