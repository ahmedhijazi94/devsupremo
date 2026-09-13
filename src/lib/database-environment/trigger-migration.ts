type Token = {
  kind: 'word' | 'literal' | 'body' | 'symbol'
  value: string
  start: number
  end: number
  bodyStart?: number
}

function reject(): never {
  throw new Error('Migration exige revisão: função/gatilho fora do formato automático. Use função nova, sem argumentos, RETURNS TRIGGER, LANGUAGE plpgsql, SECURITY INVOKER e SET search_path = vazio; declare-a antes do gatilho na mesma migration.')
}

/** Lexer restrito: preserva posições, não confunde ;/BEGIN em strings com SQL.
 * Sintaxe ambígua ou incompleta falha fechada, antes de qualquer escrita.
 */
function tokenize(sql: string, offset = 0): Token[] {
  const tokens: Token[] = []
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
      while (depth && i < sql.length) {
        if (sql.startsWith('/*', i)) { depth++; i += 2 }
        else if (sql.startsWith('*/', i)) { depth--; i += 2 }
        else i++
      }
      if (depth) reject()
      continue
    }
    const start = i
    const quote = sql[i]
    if (quote === "'" || quote === '"') {
      i++
      let closed = false
      while (i < sql.length) {
        // Escape strings/identifiers are deliberately outside this grammar.
        if (sql[i] === '\\') reject()
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) { i += 2; continue }
          i++; closed = true; break
        }
        i++
      }
      if (!closed) reject()
      tokens.push({ kind: 'literal', value: sql.slice(start, i), start: start + offset, end: i + offset })
      continue
    }
    const marker = /^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/.exec(sql.slice(i))?.[0]
    if (marker) {
      const bodyStart = i + marker.length
      const end = sql.indexOf(marker, bodyStart)
      if (end < 0) reject()
      i = end + marker.length
      tokens.push({ kind: 'body', value: sql.slice(bodyStart, end), start: start + offset, end: i + offset, bodyStart: bodyStart + offset })
      continue
    }
    const word = /^[A-Za-z_][A-Za-z_0-9$]*/.exec(sql.slice(i))?.[0]
    i += word?.length ?? 1
    tokens.push({ kind: word ? 'word' : 'symbol', value: sql.slice(start, i).toLowerCase(), start: start + offset, end: i + offset })
  }
  return tokens
}

function signature(tokens: Token[]): string {
  return tokens.map((token) => token.kind === 'body' ? '$body$' : token.value).join(' ')
}

/** Only masks two already-verified syntactic constructs in the guard's view.
 * The original SQL, including the entire function body, still goes through
 * the security guard and is the only SQL sent to PostgreSQL.
 */
export function maskVerifiedTriggerSyntax(sql: string): string {
  // Migrations without either formerly forbidden token keep the existing
  // policy unchanged; this grammar only governs the new syntactic exception.
  if (!/\b(begin|execute)\b/i.test(sql)) return sql
  const tokens = tokenize(sql)
  const ranges: Array<{ start: number; end: number }> = []
  const functions = new Set<string>()
  let current: Token[] = []

  const inspect = (statement: Token[]): void => {
    if (!statement.length) return
    const text = signature(statement)
    if (/^(begin|start|end|abort|commit|rollback|savepoint|release|set|reset|discard|do|call)\b/.test(text)) reject()
    if (/^create (?:or replace )?function\b/.test(text)) {
      const header = /^create function ((?:public|private) \. [a-z_][a-z_0-9]*) \( \) returns trigger (.+)$/.exec(text)
      if (!header) reject()
      // Each option is mandatory and unique; no other clauses are accepted.
      let options = header[2]!
      for (const required of ['language plpgsql', 'security invoker', "set search_path = ''", 'as $body$']) {
        if (!options.includes(required)) reject()
        options = options.replace(required, '')
      }
      if (options.trim()) reject()
      const body = statement.find((token) => token.kind === 'body')!
      const bodyTokens = tokenize(body.value, body.bodyStart)
      // A static invoker trigger may append audit rows or assign NEW fields.
      // It may not perform DDL, invoke arbitrary procedures or change session
      // settings. Destructive writes/dynamic EXECUTE remain denied by policy.
      if (/\b(create|alter|grant|revoke|perform|set|reset|discard|set_config|savepoint|release|start|abort|merge|end\s+transaction)\b/i.test(signature(bodyTokens))) reject()
      for (const token of bodyTokens) {
        if (token.kind === 'word' && token.value === 'begin') ranges.push(token)
      }
      const name = header[1]!
      if (functions.has(name)) reject()
      functions.add(name)
    }
    if (/^create (?:or replace |constraint )?trigger\b/.test(text)) {
      const trigger = /^create trigger [a-z_][a-z_0-9]* (?:before|after) (?:insert|update|delete)(?: or (?:insert|update|delete))* on public \. [a-z_][a-z_0-9]* for each row execute function ((?:public|private) \. [a-z_][a-z_0-9]*) \( \)$/.exec(text)
      if (!trigger || (trigger[1] !== 'public . set_updated_at' && !functions.has(trigger[1]!))) reject()
      const execute = statement.find((token) => token.kind === 'word' && token.value === 'execute')!
      ranges.push({ start: execute.start, end: statement[statement.length - 1]!.end })
    }
  }
  for (const token of tokens) {
    if (token.kind === 'symbol' && token.value === ';') {
      inspect(current)
      current = []
    } else current.push(token)
  }
  inspect(current)

  let result = sql
  for (const { start, end } of ranges.sort((a, b) => b.start - a.start)) {
    result = result.slice(0, start) + ' '.repeat(end - start) + result.slice(end)
  }
  return result
}
