import { UnsafeSqlError } from '@/lib/database/sql-guard'
import { isSensitiveIdentifier } from './sensitive'

interface Token {
  value: string
  start: number
  end: number
  kind: 'word' | 'literal' | 'symbol'
}
const deny = () => {
  throw new UnsafeSqlError(
    'Consulta recusada: use um SELECT/WITH de leitura em tabelas public, sem comandos de sessão, funções externas ou acesso a credenciais. Use inspect para consultar a estrutura.',
  )
}

// Intentionally a restricted SQL dialect, not a claim to parse all PostgreSQL.
// READ ONLY plus the provider's supabase_read_only_user remain independent guards.
function tokenize(sql: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < sql.length) {
    if (/\s/.test(sql[i]!)) {
      i++
      continue
    }
    const start = i
    if (sql[i] === "'") {
      i++
      let closed = false
      while (i < sql.length) {
        if (sql[i] === '\\') deny()
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2
            continue
          }
          i++
          closed = true
          break
        }
        i++
      }
      if (!closed) deny()
      tokens.push({
        value: sql.slice(start, i),
        start,
        end: i,
        kind: 'literal',
      })
      continue
    }
    if (sql[i] === '"') {
      const end = sql.indexOf('"', i + 1)
      const value = sql.slice(i + 1, end)
      if (end < 0 || !/^[a-z_][a-z0-9_]*$/i.test(value)) deny()
      i = end + 1
      tokens.push({ value: value.toLowerCase(), start, end: i, kind: 'word' })
      continue
    }
    const word = /^[a-z_][a-z0-9_]*/i.exec(sql.slice(i))
    if (word) {
      i += word[0].length
      tokens.push({ value: word[0].toLowerCase(), start, end: i, kind: 'word' })
      continue
    }
    if (
      sql.startsWith('--', i) ||
      sql.startsWith('/*', i) ||
      /[$\\`]/.test(sql[i]!)
    )
      deny()
    if (!/[0-9.,;()\[\]+*/%<>=!|:\-]/.test(sql[i]!)) deny()
    i++
    tokens.push({ value: sql[start]!, start, end: i, kind: 'symbol' })
  }
  return tokens
}

const FUNCTIONS = new Set(
  'count sum avg min max now date_trunc date_part extract age to_char lower upper length char_length trim btrim ltrim rtrim substring substr replace concat concat_ws round ceil ceiling floor abs greatest least json_agg jsonb_agg json_build_object jsonb_build_object json_object_agg jsonb_object_agg array_agg string_agg bool_and bool_or row_number rank dense_rank lag lead first_value last_value jsonb_array_length jsonb_typeof json_typeof'.split(
    ' ',
  ),
)
const SYNTAX_CALLS = new Set([
  'as',
  'in',
  'exists',
  'over',
  'filter',
  'select',
  'distinct',
  'coalesce',
  'nullif',
  'cast',
  'case',
  'join',
  'from',
  'lateral',
  'where',
  'and',
  'or',
  'not',
  'when',
  'then',
  'else',
  'on',
  'having',
])
const SPECIAL_FUNCTIONS = new Set([
  'extract',
  'substring',
  'trim',
  'greatest',
  'least',
])
const FORBIDDEN =
  /^(insert|update|delete|merge|truncate|create|alter|drop|grant|revoke|copy|call|do|execute|prepare|deallocate|begin|commit|rollback|savepoint|release|set|reset|discard|vacuum|analyze|reindex|cluster|refresh|lock|listen|notify|unlisten|load|into|recursive|operator|tablesample|auth|vault|storage|information_schema|pg_temp)$/

/** Column aliases never authorize a schema. Inspect FROM/JOIN/comma relation
 * positions independently of dotted column references, including subqueries. */
function inspectRelations(tokens: Token[]): {
  qualifiers: Set<string>
  declarations: Set<number>
} {
  const ctes = new Set<string>()
  const declarations = new Set<number>()
  for (let i = 0; i < tokens.length; i++) {
    if (
      ['with', ','].includes(tokens[i]?.value ?? '') &&
      tokens[i + 1]?.kind === 'word' &&
      tokens[i + 2]?.value === 'as' &&
      tokens[i + 3]?.value === '('
    ) {
      ctes.add(tokens[i + 1]!.value)
      declarations.add(i + 1)
    }
  }
  const qualifiers = new Set(['public', 'pg_catalog', ...ctes])
  const frames = [{ inFrom: false, scalar: false }]
  const clauseEnd = new Set([
    'where',
    'group',
    'having',
    'order',
    'limit',
    'offset',
    'union',
    'intersect',
    'except',
    'window',
    'for',
  ])
  const reservedAlias = new Set([
    ...clauseEnd,
    'join',
    'inner',
    'left',
    'right',
    'full',
    'cross',
    'outer',
    'on',
    'using',
    'natural',
  ])
  const relation = (start: number) => {
    let index = start
    if (tokens[index]?.value === 'lateral' || tokens[index]?.value === 'only')
      index++
    if (tokens[index]?.value === '(') {
      if (!['select', 'with'].includes(tokens[index + 1]?.value ?? '')) deny()
      let depth = 1
      index++
      while (index < tokens.length && depth > 0) {
        if (tokens[index]?.value === '(') depth++
        if (tokens[index]?.value === ')') depth--
        index++
      }
      if (depth !== 0) deny()
    } else {
      if (tokens[index]?.kind !== 'word') deny()
      if (tokens[index + 1]?.value === '.') {
        if (
          tokens[index]?.value !== 'public' ||
          tokens[index + 2]?.kind !== 'word' ||
          tokens[index + 3]?.value === '.'
        )
          deny()
        declarations.add(index)
        declarations.add(index + 2)
        qualifiers.add(tokens[index + 2]!.value)
        index += 3
      } else {
        if (!ctes.has(tokens[index]!.value)) deny()
        declarations.add(index)
        index++
      }
      if (tokens[index]?.value === '(') deny() // table-valued functions are not data relations
    }
    if (tokens[index]?.value === 'as') index++
    const alias = tokens[index]
    if (alias?.kind === 'word' && !reservedAlias.has(alias.value)) {
      if (['public', 'pg_catalog'].includes(alias.value)) deny()
      if (tokens[index + 1]?.value === '(') deny()
      qualifiers.add(alias.value)
      declarations.add(index)
    }
  }
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!
    if (token.kind === 'literal') continue
    if (token.value === '(') {
      const previous = tokens[index - 1]?.value ?? ''
      frames.push({
        inFrom: false,
        scalar: FUNCTIONS.has(previous) || SPECIAL_FUNCTIONS.has(previous),
      })
      continue
    }
    if (token.value === ')') {
      if (frames.length === 1) deny()
      frames.pop()
      continue
    }
    const frame = frames[frames.length - 1]!
    if (frame.scalar) continue
    if (clauseEnd.has(token.value)) frame.inFrom = false
    if (token.value === 'from' || token.value === 'join') {
      relation(index + 1)
      frame.inFrom = true
    } else if (token.value === ',' && frame.inFrom) relation(index + 1)
  }
  return { qualifiers, declarations }
}

export function inspectSelectSql(sql: string): string {
  const tokens = tokenize(sql.trim())
  if (tokens[tokens.length - 1]?.value === ';') tokens.pop()
  if (!tokens.length || !['select', 'with'].includes(tokens[0]!.value)) deny()
  let depth = 0
  const replacements: Array<{ start: number; end: number; text: string }> = []
  const { qualifiers, declarations } = inspectRelations(tokens)
  for (const [index, token] of tokens.entries()) {
    const previous = tokens[index - 1]
    const next = tokens[index + 1]
    if (token.kind === 'literal') continue
    if (token.value === ';') deny()
    if (token.value === '(') depth++
    if (token.value === ')' && --depth < 0) deny()
    if (token.value === '*' && previous?.value === '.') deny()
    if (token.value === '*' && previous?.value !== '.') {
      const countStar =
        previous?.value === '(' &&
        tokens[index - 2]?.value === 'count' &&
        next?.value === ')'
      const directStar =
        index === 1 &&
        tokens[0]?.value === 'select' &&
        next?.value === 'from' &&
        !tokens.some(
          (part) =>
            part.kind === 'word' &&
            ['union', 'intersect', 'except', 'with'].includes(part.value),
        )
      const multiplication =
        (previous?.kind === 'word' &&
          !['select', 'distinct', 'all'].includes(previous.value)) ||
        previous?.kind === 'literal' ||
        previous?.value === ')' ||
        /^[0-9]$/.test(previous?.value ?? '')
      if (!countStar && !directStar && !multiplication) deny()
    }
    if (token.kind !== 'word') continue
    if (next?.value === '.' && !qualifiers.has(token.value)) deny()
    if (
      previous?.value === '.' &&
      tokens[index - 2]?.value === 'public' &&
      !declarations.has(index)
    )
      deny()
    // A record cast/aggregate loses credential column names before redaction.
    // Require explicit safe fields; SELECT * remains structured and redacted.
    if (
      qualifiers.has(token.value) &&
      !['public', 'pg_catalog'].includes(token.value) &&
      next?.value !== '.' &&
      previous?.value !== '.' &&
      !declarations.has(index)
    )
      deny()
    if (
      FORBIDDEN.test(token.value) ||
      isSensitiveIdentifier(token.value) ||
      (token.value.startsWith('pg_') && token.value !== 'pg_catalog') ||
      (token.value === 'for' &&
        ['update', 'share', 'no', 'key'].includes(next?.value ?? ''))
    )
      deny()
    if (
      token.value === 'pg_catalog' &&
      !(
        next?.value === '.' &&
        FUNCTIONS.has(tokens[index + 2]?.value ?? '') &&
        tokens[index + 3]?.value === '('
      )
    )
      deny()
    if (next?.value !== '(') continue
    if (SYNTAX_CALLS.has(token.value) || SPECIAL_FUNCTIONS.has(token.value)) {
      if (previous?.value === '.' || sql.trim()[token.start] === '"') deny()
      continue
    }
    if (!FUNCTIONS.has(token.value)) deny()
    if (previous?.value === '.') {
      if (tokens[index - 2]?.value !== 'pg_catalog') deny()
    } else
      replacements.push({
        start: token.start,
        end: token.end,
        text: `pg_catalog.${token.value}`,
      })
  }
  if (depth !== 0) deny()
  // Casts can invoke user-defined functions; only PostgreSQL built-in types.
  const types = new Set([
    'text',
    'varchar',
    'character',
    'integer',
    'int',
    'int2',
    'int4',
    'int8',
    'bigint',
    'smallint',
    'numeric',
    'decimal',
    'real',
    'float4',
    'float8',
    'double',
    'boolean',
    'bool',
    'uuid',
    'date',
    'timestamp',
    'timestamptz',
    'time',
    'interval',
    'json',
    'jsonb',
  ])
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index]?.value === ':' && tokens[index + 1]?.value === ':') {
      if (
        !types.has(tokens[index + 2]?.value ?? '') ||
        tokens[index + 3]?.value === '.'
      )
        deny()
    }
    if (tokens[index]?.value === 'cast') deny() // use the explicitly checked ::type form
  }
  let result = sql.trim().slice(0, tokens[tokens.length - 1]!.end)
  for (const change of replacements.reverse())
    result =
      result.slice(0, change.start) + change.text + result.slice(change.end)
  return result
}

/** The final result-bearing statement stays last (postgres-meta returns its
 * rows). The provider closes this request's connection, rolling back the read
 * transaction. Never use the privileged /database/query as a fallback. */
export function readOnlyTransaction(sql: string): string {
  return `BEGIN READ ONLY;\nSET LOCAL statement_timeout = '8s';\nSET LOCAL lock_timeout = '1s';\nSET LOCAL idle_in_transaction_session_timeout = '10s';\nSET LOCAL search_path = pg_catalog, public;\n${sql}`
}

export function pagedSelectSql(
  sql: string,
  limit: number,
  offset: number,
): string {
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 200 ||
    !Number.isInteger(offset) ||
    offset < 0 ||
    offset > 10_000
  )
    deny()
  return `SELECT * FROM (${inspectSelectSql(sql)}) AS supremo_result LIMIT ${limit + 1} OFFSET ${offset}`
}
