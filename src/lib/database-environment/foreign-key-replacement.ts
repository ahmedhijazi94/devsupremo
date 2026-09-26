import { tokenizeForeignKeySql, type ForeignKeySqlToken } from './foreign-key-contract'

export interface ForeignKeyReplacement {
  table: string
  constraint: string
  column: string
  referencedSchema: 'public' | 'auth'
  referencedTable: string
  referencedColumn: string
}

const identifier = /^[A-Za-z_][A-Za-z_0-9]{0,62}$/
const maximumReplacements = 100

function reject(): never {
  throw new Error('Migration exige revisão: DROP só é automático ao substituir a mesma foreign key por uma definição equivalente com ON DELETE NO ACTION, sem outras operações. Nenhuma alteração foi aplicada.')
}

/** This is an intentionally closed grammar, not a generic DROP permission.
 * Literal bodies and comments never supply keywords; identifiers are bounded
 * and unescaped by the shared lexer before comparison or SQL generation.
 */
export function parseForeignKeyReplacements(sql: string): ForeignKeyReplacement[] {
  const tokens = tokenizeForeignKeySql(sql)
  if (!tokens.some(token => token.kind === 'word' && token.value === 'drop')) return []
  const replacements: ForeignKeyReplacement[] = []
  const seen = new Set<string>()
  let cursor = 0
  const consume = (kind: ForeignKeySqlToken['kind'], value: string): void => {
    const token = tokens[cursor++]
    if (!token || token.kind !== kind || token.value !== value) reject()
  }
  const word = (value: string): void => consume('word', value)
  const symbol = (value: string): void => consume('symbol', value)
  const name = (): string => {
    const token = tokens[cursor++]
    if (!token || !['word', 'identifier'].includes(token.kind) || !identifier.test(token.value)) reject()
    return token.value
  }
  while (cursor < tokens.length) {
    word('alter'); word('table')
    if (name() !== 'public') reject()
    symbol('.')
    const table = name()
    word('drop'); word('constraint')
    const constraint = name()
    symbol(','); word('add'); word('constraint')
    if (name() !== constraint) reject()
    word('foreign'); word('key'); symbol('(')
    const column = name()
    symbol(')'); word('references')
    const referencedSchema = name()
    if (referencedSchema !== 'public' && referencedSchema !== 'auth') reject()
    symbol('.')
    const referencedTable = name()
    symbol('(')
    const referencedColumn = name()
    symbol(')'); word('on'); word('delete'); word('no'); word('action')
    if (cursor < tokens.length) symbol(';')
    const key = `${table}.${constraint}`
    if (seen.has(key) || replacements.length >= maximumReplacements) reject()
    seen.add(key)
    replacements.push({ table, constraint, column, referencedSchema, referencedTable, referencedColumn })
  }
  return replacements
}

const quoteIdent = (value: string): string => `"${value}"`
const quoteLiteral = (value: string): string => `'${value}'`

function assertReplacementNames(value: ForeignKeyReplacement): void {
  if (![value.table, value.constraint, value.column, value.referencedTable, value.referencedColumn]
    .every(name => typeof name === 'string' && identifier.test(name)) || !['public', 'auth'].includes(value.referencedSchema)) reject()
}

function existingEquivalentConstraint(value: ForeignKeyReplacement): string {
  const literal = quoteLiteral
  return `EXISTS (
  SELECT 1 FROM pg_catalog.pg_constraint c
  JOIN pg_catalog.pg_class source_table ON source_table.oid = c.conrelid
  JOIN pg_catalog.pg_namespace source_schema ON source_schema.oid = source_table.relnamespace
  JOIN pg_catalog.pg_class target_table ON target_table.oid = c.confrelid
  JOIN pg_catalog.pg_namespace target_schema ON target_schema.oid = target_table.relnamespace
  JOIN pg_catalog.pg_attribute source_column ON source_column.attrelid = source_table.oid
    AND source_column.attname = ${literal(value.column)} AND source_column.attnum > 0 AND NOT source_column.attisdropped
  JOIN pg_catalog.pg_attribute target_column ON target_column.attrelid = target_table.oid
    AND target_column.attname = ${literal(value.referencedColumn)} AND target_column.attnum > 0 AND NOT target_column.attisdropped
  WHERE source_schema.nspname = 'public' AND source_table.relname = ${literal(value.table)}
    AND target_schema.nspname = ${literal(value.referencedSchema)} AND target_table.relname = ${literal(value.referencedTable)}
    AND c.conname = ${literal(value.constraint)} AND c.contype = 'f'
    AND c.conkey = ARRAY[source_column.attnum]::pg_catalog.int2[]
    AND c.confkey = ARRAY[target_column.attnum]::pg_catalog.int2[]
    AND c.confdeltype = 'a' AND c.confupdtype = 'a' AND c.confmatchtype = 's'
    AND NOT c.condeferrable AND NOT c.condeferred AND c.convalidated
    AND c.conparentid = 0 AND c.coninhcount = 0 AND c.conislocal
    AND COALESCE((pg_catalog.to_jsonb(c)->>'conenforced')::pg_catalog.bool, true)
    AND NOT COALESCE((pg_catalog.to_jsonb(c)->>'conperiod')::pg_catalog.bool, false)
    AND source_table.relkind = 'r' AND NOT source_table.relispartition AND source_table.relrowsecurity
    AND target_table.relkind = 'r' AND NOT target_table.relispartition
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_inherits inheritance
      WHERE inheritance.inhrelid IN (source_table.oid, target_table.oid)
        OR inheritance.inhparent IN (source_table.oid, target_table.oid))
    AND (SELECT count(*) FROM pg_catalog.pg_trigger trg WHERE trg.tgconstraint = c.oid) = 4
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger trg WHERE trg.tgconstraint = c.oid
      AND (NOT trg.tgisinternal OR trg.tgenabled <> 'O' OR trg.tgparentid <> 0))
)`
}

/** Run only inside the unapplied-migration branch of the transaction that
 * executes the original migration. Locks precede every catalog check and stay
 * held through replacement and history registration, preventing a schema race.
 * This SQL does not itself change a constraint or begin/commit a transaction.
 */
export function foreignKeyReplacementPreconditions(replacements: readonly ForeignKeyReplacement[]): string {
  if (replacements.length === 0) return ''
  if (replacements.length > maximumReplacements) reject()
  const constraints = new Set<string>()
  const relations = new Set<string>()
  for (const replacement of replacements) {
    assertReplacementNames(replacement)
    const key = `${replacement.table}.${replacement.constraint}`
    if (constraints.has(key)) reject()
    constraints.add(key)
    relations.add(`${quoteIdent('public')}.${quoteIdent(replacement.table)}`)
    relations.add(`${quoteIdent(replacement.referencedSchema)}.${quoteIdent(replacement.referencedTable)}`)
  }
  const locks = [...relations].sort().map(relation => `LOCK TABLE ONLY ${relation} IN ACCESS EXCLUSIVE MODE;`)
  const checks = replacements.map(replacement => `DO $supremo_fk_equivalence$ BEGIN
IF NOT ${existingEquivalentConstraint(replacement)} THEN
  RAISE EXCEPTION 'Foreign key incompatível: substituição automática exige a mesma relação, colunas e comportamento NO ACTION, RLS ativo e constraint validada. Nenhuma alteração foi aplicada.';
END IF;
END $supremo_fk_equivalence$;`)
  return [...locks, ...checks].join('\n')
}
