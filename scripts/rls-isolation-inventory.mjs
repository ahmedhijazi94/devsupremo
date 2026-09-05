// Offline inventory of ownership signals in the complete migration history.
import fs from 'node:fs'
import path from 'node:path'

function statements(sql) {
  // Keep identifiers; discard comments and string/function bodies so examples
  // and dynamic SQL cannot masquerade as a table declaration.
  const tokens = []
  let i = 0
  while (i < sql.length) {
    const rest = sql.slice(i)
    if (/^\s/.test(rest)) { i++; continue }
    if (rest.startsWith('--')) { const end = sql.indexOf('\n', i); i = end < 0 ? sql.length : end; continue }
    if (rest.startsWith('/*')) {
      let depth = 1; i += 2
      while (i < sql.length && depth) {
        if (sql.slice(i, i + 2) === '/*') { depth++; i += 2 }
        else if (sql.slice(i, i + 2) === '*/') { depth--; i += 2 }
        else i++
      }
      if (depth) throw new Error('Comentário SQL incompleto.')
      continue
    }
    const dollar = rest.match(/^\$(?:[a-z_][\w]*)?\$/i)?.[0]
    if (dollar) {
      const end = sql.indexOf(dollar, i + dollar.length)
      if (end < 0) throw new Error('Corpo SQL incompleto.')
      tokens.push("''"); i = end + dollar.length; continue
    }
    if (rest[0] === "'" || rest[0] === '"') {
      const quote = rest[0]; let value = quote; i++
      let closed = false
      while (i < sql.length) {
        const char = sql[i++]; value += char
        if (char === quote) {
          if (sql[i] === quote) { value += sql[i++]; continue }
          closed = true; break
        }
        if (quote === "'" && char === '\\' && i < sql.length) value += sql[i++]
      }
      if (!closed) throw new Error('Literal SQL incompleto.')
      tokens.push(quote === '"' ? value : "''"); continue
    }
    const word = rest.match(/^[a-z_][\w$]*/i)?.[0]
    if (word) { tokens.push(word.toLowerCase()); i += word.length; continue }
    tokens.push(sql[i++])
  }
  return tokens.join(' ').split(';').map((s) => s.trim()).filter(Boolean)
}
const IDENT = '(?:"(?:[^"]|"")+"|[a-z_][\\w$]*)'
const QUALIFIED = `${IDENT}(?:\\s*\\.\\s*${IDENT})?`
function qualify(raw) {
  const parts = raw.match(new RegExp(IDENT, 'g')).map((part) => part.startsWith('"') ? part.slice(1, -1).replaceAll('""', '"') : part)
  return parts.length === 1 ? `public.${parts[0]}` : parts.join('.')
}
function protectedTables(migrations) {
  const tables = new Map()
  for (const { source, file } of migrations) {
    for (const sql of statements(source)) {
      const create = sql.match(new RegExp(`^create (?:unlogged |temporary |temp )?table (?:if not exists )?(${QUALIFIED})\\s*\\(`))
      if (/^create (?:unlogged |temporary |temp )?table /.test(sql) && !create) {
        throw new Error(`${file}: CREATE TABLE não reconhecido; não é seguro omitir a tabela do gate.`)
      }
      if (create && /\b(?:like|inherits|partition of)\b/.test(sql)) {
        throw new Error(`${file}: tabela herdada/derivada exige suporte explícito no inventário de isolamento.`)
      }
      const alter = sql.match(new RegExp(`^alter table (?:if exists )?(?:only )?(${QUALIFIED})\\s+`))
      const policy = sql.match(new RegExp(`^(?:create|alter) policy ${IDENT} on (${QUALIFIED})\\s+`))
      const drop = sql.match(new RegExp(`^drop table (?:if exists )?(${QUALIFIED})(?:\\s|$)`))
      if (drop) { tables.delete(qualify(drop[1])); continue }
      const match = create || alter || policy
      if (!match) continue
      const name = qualify(match[1])
      if (alter) {
        const rename = sql.slice(alter[0].length).match(new RegExp(`^rename to (${IDENT})$`))
        if (rename) {
          const previous = tables.get(name)
          const newName = qualify(name.slice(0, name.lastIndexOf('.')) + '.' + rename[1])
          if (previous) { tables.delete(name); tables.set(newName, { ...previous, name: newName }) }
          for (const entry of tables.values()) {
            if (entry.references.delete(name)) entry.references.add(newName)
          }
          continue
        }
      }
      const table = tables.get(name) || { name, file, owned: false, references: new Set() }
      // Do not require a particular feature name or only conventional owner names.
      const body = sql.slice(match[0].length - (create ? 1 : 0))
      const plain = body.replace(/"([a-z_][\w$]*)"/g, '$1')
      if (/\b(user_id|owner_id|org_id|organization_id|team_id|workspace_id|account_id|tenant_id|company_id|group_id)\b/.test(plain)
        || /\bauth\s*\.\s*(?:uid|jwt|users)\b/.test(plain)) table.owned = true
      for (const ref of body.matchAll(new RegExp(`\\breferences\\s+(${QUALIFIED})`, 'g'))) table.references.add(qualify(ref[1]))
      if (policy) {
        // A policy delegating to a function is still security-sensitive, even
        // when ownership is hidden in that function; require executable proof.
        if (/\b(?:using|check)\s*\(/.test(body) && !/\b(?:using|check)\s*\(\s*(?:true|false)\s*\)\s*$/.test(body)) table.owned = true
      }
      tables.set(name, table)
    }
  }
  let changed = true
  while (changed) {
    changed = false
    for (const table of tables.values()) {
      if (!table.owned && [...table.references].some((ref) => ref === 'auth.users' || tables.get(ref)?.owned)) {
        table.owned = true; changed = true
      }
    }
  }
  return [...tables.values()].filter((t) => t.owned).map(({ name, file }) => ({ name, file })).sort((a, b) => a.name.localeCompare(b.name))
}
function inventory(root) {
  const dir = path.join(root, 'supabase/migrations')
  if (!fs.existsSync(dir)) throw new Error('Diretório supabase/migrations ausente.')
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
  return protectedTables(files.map((file) => ({ file: `supabase/migrations/${file}`, source: fs.readFileSync(path.join(dir, file), 'utf8') })))
}
function missingProofs(tables, proofs) {
  return tables.filter((table) => !proofs.includes(table.name))
}
export { statements, protectedTables, inventory, missingProofs }
