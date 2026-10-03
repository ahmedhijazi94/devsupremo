import { z } from 'zod'
import { DataDeleteError, deleteIdentifierSchema, deleteTargetsSchema, type DeleteTarget } from './contract'

const name = z.string().min(1).max(63)
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/)
const columnSchema = z.object({
  name, type: name, typeSchema: name, kind: z.string(), generated: z.string(),
  collationSchema: name.nullable(),
}).strict()
const tableSchema = z.object({
  oid: z.number().int().positive(), schema: name, name, kind: z.string(), rls: z.boolean(),
  partition: z.boolean(), inherits: z.boolean(), accessMethod: name.nullable(),
  columns: z.array(columnSchema).min(1).max(100),
  primaryKey: z.array(name).max(8), primaryKeyImmediate: z.boolean(),
  indexesSafe: z.boolean(), indexes: z.array(z.string()).max(100), indirectSideEffects: z.boolean(),
  deleteTriggers: z.array(z.object({
    name, internal: z.boolean(), enabled: z.string(), functionSchema: name,
    functionName: name, definition: z.string(),
  }).strict()).max(200),
  deleteRules: z.array(z.string()).max(100),
}).strict()
const foreignKeySchema = z.object({
  oid: z.number().int().positive(), name, schema: name, table: name, referencedSchema: name,
  referencedTable: name, columns: z.array(name).min(1).max(8),
  referencedColumns: z.array(name).min(1).max(8), onDelete: z.string(),
  validated: z.boolean(), deferrable: z.boolean(), operatorsSafe: z.boolean(), definition: z.string(),
}).strict()
export const deleteCatalogSchema = z.object({
  version: z.literal(1), tables: z.array(tableSchema).min(1).max(100),
  foreignKeys: z.array(foreignKeySchema).max(200),
}).strict()
export type DeleteCatalog = z.infer<typeof deleteCatalogSchema>
export const deleteSnapshotSchema = z.object({
  catalogFingerprint: fingerprint,
  rows: z.array(z.object({ index: z.number().int().min(0).max(24), count: z.number().int().min(0).max(1), fingerprint: fingerprint.nullable() }).strict()).min(1).max(25),
  impactCount: z.number().int().min(0).max(25),
  undeclaredDependencies: z.number().int().min(0).max(26), ready: z.boolean(),
}).strict()
export type DeleteSnapshot = z.infer<typeof deleteSnapshotSchema>

// Hex-encoded strings cannot terminate a DO dollar quote, even when a key
// contains quotes, backslashes, newlines or the dollar quote delimiter itself.
const literal = (value: string): string => `pg_catalog.convert_from(pg_catalog.decode('${Buffer.from(value, 'utf8').toString('hex')}','hex'),'UTF8')`
const ident = (value: string): string => `"${deleteIdentifierSchema.parse(value)}"`
const relation = (table: string): string => `"public".${ident(table)}`
const json = (value: unknown): string => `${literal(JSON.stringify(value))}::pg_catalog.jsonb`
const hash = (value: string): string => `pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to((${value})::text,'UTF8')),'hex')`
const canonicalSettings = `SET LOCAL search_path = pg_catalog;
SET LOCAL row_security = off;
SET LOCAL TimeZone = 'UTC';
SET LOCAL DateStyle = 'ISO, YMD';
SET LOCAL extra_float_digits = 3;`

/** Includes incoming references from EVERY schema. Extra catalog rows overflow
 * the parser's bounds rather than silently hiding dependencies. */
function catalogQuery(input: readonly DeleteTarget[]): string {
  const targets = deleteTargetsSchema.parse(input)
  const names = [...new Set(targets.map(target => target.table))].sort().map(literal).join(',')
  return `WITH targets AS (
 SELECT c.oid FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='public' AND c.relname IN (${names})
), refs AS (
 SELECT k.* FROM pg_catalog.pg_constraint k WHERE k.contype='f' AND k.confrelid IN (SELECT oid FROM targets)
), relevant AS (
 SELECT oid FROM targets UNION SELECT conrelid FROM refs
), tables AS (
 SELECT c.oid::bigint AS oid,n.nspname AS schema,c.relname AS name,c.relkind::text AS kind,c.relrowsecurity AS rls,
 c.relispartition AS partition,EXISTS(SELECT 1 FROM pg_catalog.pg_inherits i WHERE i.inhrelid=c.oid OR i.inhparent=c.oid) AS inherits,am.amname AS "accessMethod",
 COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('name',a.attname,'type',t.typname,'typeSchema',tn.nspname,'kind',t.typtype::text,'generated',a.attgenerated::text,'collationSchema',cn.nspname) ORDER BY a.attnum)
 FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_type t ON t.oid=a.atttypid JOIN pg_catalog.pg_namespace tn ON tn.oid=t.typnamespace
 LEFT JOIN pg_catalog.pg_collation co ON co.oid=a.attcollation LEFT JOIN pg_catalog.pg_namespace cn ON cn.oid=co.collnamespace
 WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),'[]'::jsonb) AS columns,
 COALESCE((SELECT pg_catalog.jsonb_agg(a.attname ORDER BY keys.ordinality) FROM pg_catalog.pg_index i CROSS JOIN LATERAL pg_catalog.unnest(i.indkey) WITH ORDINALITY keys(attnum,ordinality)
 JOIN pg_catalog.pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=keys.attnum WHERE i.indrelid=c.oid AND i.indisprimary AND i.indisvalid AND keys.ordinality<=i.indnkeyatts),'[]'::jsonb) AS "primaryKey",
 COALESCE((SELECT pg_catalog.bool_and(i.indimmediate AND i.indisvalid) FROM pg_catalog.pg_index i WHERE i.indrelid=c.oid AND i.indisprimary),false) AS "primaryKeyImmediate",
 NOT EXISTS(SELECT 1 FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class ic ON ic.oid=i.indexrelid JOIN pg_catalog.pg_am ia ON ia.oid=ic.relam WHERE i.indrelid=c.oid
 AND (ia.amname NOT IN ('btree','hash','gin','gist','spgist','brin') OR i.indexprs IS NOT NULL OR i.indpred IS NOT NULL OR NOT i.indisvalid OR EXISTS(
 SELECT 1 FROM pg_catalog.unnest(i.indclass) op(oid) JOIN pg_catalog.pg_opclass oc ON oc.oid=op.oid JOIN pg_catalog.pg_namespace ons ON ons.oid=oc.opcnamespace WHERE ons.nspname<>'pg_catalog'))) AS "indexesSafe",
 COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.pg_get_indexdef(i.indexrelid) ORDER BY i.indexrelid) FROM pg_catalog.pg_index i WHERE i.indrelid=c.oid),'[]'::jsonb) AS indexes,
 COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('name',tr.tgname,'internal',tr.tgisinternal,'enabled',tr.tgenabled::text,'functionSchema',pn.nspname,'functionName',p.proname,'definition',pg_catalog.pg_get_triggerdef(tr.oid)) ORDER BY tr.oid)
 FROM pg_catalog.pg_trigger tr JOIN pg_catalog.pg_proc p ON p.oid=tr.tgfoid JOIN pg_catalog.pg_namespace pn ON pn.oid=p.pronamespace WHERE tr.tgrelid=c.oid AND (tr.tgtype & 8)<>0),'[]'::jsonb) AS "deleteTriggers",
 COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.pg_get_ruledef(r.oid) ORDER BY r.oid) FROM pg_catalog.pg_rewrite r WHERE r.ev_class=c.oid AND r.ev_type='4'),'[]'::jsonb) AS "deleteRules",
 (EXISTS(SELECT 1 FROM pg_catalog.pg_trigger tr WHERE tr.tgrelid=c.oid AND NOT tr.tgisinternal AND (tr.tgtype & 1)=0 AND (tr.tgtype & 24)<>0)
 OR EXISTS(SELECT 1 FROM pg_catalog.pg_rewrite r WHERE r.ev_class=c.oid AND r.ev_type IN ('2','4'))) AS "indirectSideEffects"
 FROM relevant rr JOIN pg_catalog.pg_class c ON c.oid=rr.oid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_catalog.pg_am am ON am.oid=c.relam ORDER BY n.nspname,c.relname LIMIT 101
), foreign_keys AS (
 SELECT k.oid::bigint AS oid,k.conname AS name,n.nspname AS schema,c.relname AS table,rn.nspname AS "referencedSchema",rc.relname AS "referencedTable",
 (SELECT pg_catalog.jsonb_agg(a.attname ORDER BY keys.ordinality) FROM pg_catalog.unnest(k.conkey) WITH ORDINALITY keys(attnum,ordinality) JOIN pg_catalog.pg_attribute a ON a.attrelid=k.conrelid AND a.attnum=keys.attnum) AS columns,
 (SELECT pg_catalog.jsonb_agg(a.attname ORDER BY keys.ordinality) FROM pg_catalog.unnest(k.confkey) WITH ORDINALITY keys(attnum,ordinality) JOIN pg_catalog.pg_attribute a ON a.attrelid=k.confrelid AND a.attnum=keys.attnum) AS "referencedColumns",
 k.confdeltype::text AS "onDelete",k.convalidated AS validated,k.condeferrable AS deferrable,
 NOT EXISTS(SELECT 1 FROM pg_catalog.unnest(k.conpfeqop) op(oid) JOIN pg_catalog.pg_operator o ON o.oid=op.oid JOIN pg_catalog.pg_namespace ons ON ons.oid=o.oprnamespace JOIN pg_catalog.pg_proc p ON p.oid=o.oprcode JOIN pg_catalog.pg_namespace pn ON pn.oid=p.pronamespace WHERE ons.nspname<>'pg_catalog' OR o.oprname<>'=' OR pn.nspname<>'pg_catalog') AS "operatorsSafe",
 pg_catalog.pg_get_constraintdef(k.oid) AS definition
 FROM refs k JOIN pg_catalog.pg_class c ON c.oid=k.conrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace JOIN pg_catalog.pg_class rc ON rc.oid=k.confrelid JOIN pg_catalog.pg_namespace rn ON rn.oid=rc.relnamespace ORDER BY k.oid LIMIT 201
) SELECT pg_catalog.jsonb_build_object('version',1,'tables',COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t) ORDER BY t.schema,t.name) FROM tables t),'[]'::jsonb),'foreignKeys',COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(f) ORDER BY f.oid) FROM foreign_keys f),'[]'::jsonb)) AS catalog`
}

export function buildDeleteCatalogQuery(input: readonly DeleteTarget[]): string {
  return `${canonicalSettings}\n${catalogQuery(input)};`
}

const safeTypes = new Set(['text', 'varchar', 'bpchar', 'bool', 'int2', 'int4', 'int8', 'numeric', 'float4', 'float8', 'uuid', 'timestamp', 'timestamptz', 'date', 'jsonb', 'json', 'bytea'])
const nonKeyTypes = new Set(['json', 'jsonb', 'bytea'])
function reject(message: string): never { throw new DataDeleteError(message) }

/** Intentionally a narrow declarative delete, not an arbitrary SQL approval. */
export function validateDeleteCatalog(input: readonly DeleteTarget[], raw: unknown): DeleteCatalog {
  const targets = deleteTargetsSchema.parse(input)
  const catalog = deleteCatalogSchema.parse(raw)
  const targetNames = new Set(targets.map(target => target.table))
  const tables = new Map(catalog.tables.map(table => [`${table.schema}.${table.name}`, table]))
  if (tables.size !== catalog.tables.length) reject('Catálogo de exclusão contém tabelas duplicadas.')
  for (const table of catalog.tables) {
    if (table.schema !== 'public' || !deleteIdentifierSchema.safeParse(table.name).success || table.kind !== 'r' || !table.rls || table.partition || table.inherits || table.accessMethod !== 'heap')
      reject('Exclusão exige tabelas public comuns com RLS, sem partições ou herança; referência externa está fora do suporte deste canal. Nada foi excluído.')
    if (!table.indexesSafe) reject('Índices personalizados impedem confirmar o impacto com segurança.')
    // Referential actions can issue DELETE/UPDATE even when no child row
    // matches: statement triggers and rules would still have indirect effects.
    if (table.indirectSideEffects) reject('Triggers por instrução ou regras de escrita podem ter efeitos indiretos; operação fora do suporte deste canal. Nada foi excluído.')
    const isTarget = targetNames.has(table.name)
    if (isTarget && (table.deleteRules.length || table.deleteTriggers.some(trigger => !trigger.internal || trigger.functionSchema !== 'pg_catalog' || !/^RI_FKey_(cascade_del|restrict_del|noaction_del|setnull_del|setdefault_del)$/.test(trigger.functionName) || !['O', 'A'].includes(trigger.enabled))))
      reject('Regras, triggers de exclusão ou índices personalizados impedem confirmar o impacto com segurança.')
    if (isTarget && (!table.primaryKey.length || !table.primaryKeyImmediate || new Set(table.primaryKey).size !== table.primaryKey.length || new Set(table.columns.map(column => column.name)).size !== table.columns.length))
      reject('Exclusão exige uma chave primária completa, imediata e válida.')
    const referencedColumns = new Set(catalog.foreignKeys.filter(fk => fk.schema === table.schema && fk.table === table.name).flatMap(fk => fk.columns))
    for (const column of table.columns.filter(column => isTarget || referencedColumns.has(column.name))) {
      if (!deleteIdentifierSchema.safeParse(column.name).success || column.typeSchema !== 'pg_catalog' || column.kind !== 'b' || !safeTypes.has(column.type) || column.generated || (column.collationSchema !== null && column.collationSchema !== 'pg_catalog'))
        reject('Tipo, coluna calculada ou collation não suportado pela exclusão delimitada.')
    }
    if (isTarget && table.primaryKey.some(key => !table.columns.some(column => column.name === key && !nonKeyTypes.has(column.type)))) reject('Tipo de chave primária não suportado pela exclusão delimitada.')
  }
  const distinctTargets = new Set<string>()
  for (const target of targets) {
    const table = tables.get(`public.${target.table}`)
    if (!table || table.primaryKey.length !== Object.keys(target.key).length || table.primaryKey.some(key => !Object.hasOwn(target.key, key))) reject('Informe a chave primária completa de uma tabela existente.')
    const signature = JSON.stringify([target.table, table.primaryKey.map(key => target.key[key])])
    if (distinctTargets.has(signature)) reject('A mesma linha foi informada mais de uma vez.')
    distinctTargets.add(signature)
    for (const value of Object.values(target.key)) {
      if (typeof value === 'string' && value.includes('\0')) reject('A chave contém um caractere inválido.')
      if (typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value)) reject('Informe chaves numéricas grandes como texto para preservar a precisão.')
    }
  }
  for (const fk of catalog.foreignKeys) {
    const child = tables.get(`${fk.schema}.${fk.table}`), parent = tables.get(`${fk.referencedSchema}.${fk.referencedTable}`)
    if (!child || !parent || !fk.validated || !fk.operatorsSafe || fk.columns.length !== fk.referencedColumns.length || !['a', 'r', 'c', 'n', 'd'].includes(fk.onDelete) || fk.columns.some(column => !child.columns.some(item => item.name === column)) || fk.referencedColumns.some(column => !parent.columns.some(item => item.name === column)))
      reject('Referência de banco incompleta ou não suportada; impacto não confirmado.')
    const childIndexes = targets.flatMap((target, index) => target.table === fk.table ? [index] : [])
    const parentIndexes = targets.flatMap((target, index) => target.table === fk.referencedTable ? [index] : [])
    if (!parentIndexes.length) reject('Catálogo contém referência fora dos alvos solicitados.')
    if (childIndexes.length && Math.max(...childIndexes) >= Math.min(...parentIndexes)) reject('Informe primeiro as linhas dependentes, depois seus pais; ciclos e autorreferências estão fora do suporte deste canal. Nada foi excluído.')
  }
  return catalog
}

function predicate(target: DeleteTarget, catalog: DeleteCatalog, alias: string): string {
  const table = catalog.tables.find(item => item.schema === 'public' && item.name === target.table)!
  return table.primaryKey.map(key => {
    const column = table.columns.find(item => item.name === key)!
    return `${alias}.${ident(key)} OPERATOR(pg_catalog.=) ${literal(String(target.key[key]))}::pg_catalog.${ident(column.type)}`
  }).join(' AND ')
}

function snapshotQuery(targets: readonly DeleteTarget[], catalog: DeleteCatalog): string {
  const rows = targets.map((target, index) => `SELECT ${index} AS index,pg_catalog.count(*)::integer AS count,pg_catalog.min(${hash("pg_catalog.jsonb_build_object('row',pg_catalog.to_jsonb(r),'xmin',r.xmin::text,'tableOid',r.tableoid::bigint)")}) AS fingerprint FROM ${relation(target.table)} r WHERE ${predicate(target, catalog, 'r')}`)
  const dependencies = catalog.foreignKeys.flatMap(fk => targets.filter(target => target.table === fk.referencedTable).map(target => {
    const declared = targets.filter(candidate => candidate.table === fk.table)
    const join = fk.columns.map((column, index) => `p.${ident(fk.referencedColumns[index]!)} OPERATOR(pg_catalog.=) d.${ident(column)}`).join(' AND ')
    return `(SELECT 1 FROM ${relation(fk.table)} d JOIN ${relation(fk.referencedTable)} p ON ${join} WHERE ${predicate(target, catalog, 'p')}${declared.length ? ` AND NOT (${declared.map(candidate => `(${predicate(candidate, catalog, 'd')})`).join(' OR ')})` : ''} LIMIT 26)`
  }))
  return `WITH catalog_now AS (${catalogQuery(targets)}),rows AS (${rows.join(' UNION ALL ')}),dependencies AS (${dependencies.length ? dependencies.join(' UNION ALL ') : 'SELECT 1 WHERE false'}),impact AS (SELECT pg_catalog.sum(count)::integer AS count FROM rows),unlisted AS (SELECT pg_catalog.count(*)::integer AS count FROM (SELECT * FROM dependencies LIMIT 26) bounded)
 SELECT pg_catalog.jsonb_build_object('catalogFingerprint',${hash('c.catalog')},'rows',(SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(r) ORDER BY r.index) FROM rows r),'impactCount',i.count,'undeclaredDependencies',u.count,'ready',c.catalog=${json(catalog)} AND i.count=${targets.length} AND (SELECT pg_catalog.count(DISTINCT fingerprint) FROM rows)=${targets.length} AND u.count=0 AND pg_catalog.current_setting('session_replication_role')='origin') AS snapshot FROM catalog_now c CROSS JOIN impact i CROSS JOIN unlisted u`
}

/** Returns one {snapshot} result; no application row or secret value is returned. */
export function buildDeleteInspection(input: readonly DeleteTarget[], raw: unknown): string {
  const targets = deleteTargetsSchema.parse(input), catalog = validateDeleteCatalog(targets, raw)
  return `${canonicalSettings}\n${snapshotQuery(targets, catalog)};`
}

/** Locks prevent DML and relevant FK/trigger/schema changes until commit. All
 * checks and deletes share a transaction, so a stale plan or failed count rolls
 * back EVERY deletion. The caller independently enforces owner, dev and single use. */
export function buildDeleteApply(input: readonly DeleteTarget[], raw: unknown, rawSnapshot: unknown): string {
  const targets = deleteTargetsSchema.parse(input), catalog = validateDeleteCatalog(targets, raw)
  const snapshot = deleteSnapshotSchema.parse(rawSnapshot)
  if (!snapshot.ready || snapshot.impactCount !== targets.length || snapshot.undeclaredDependencies || snapshot.rows.length !== targets.length || snapshot.rows.some((row, index) => row.index !== index || row.count !== 1 || !row.fingerprint))
    reject('O plano não confirmou exatamente todas as linhas e dependências solicitadas.')
  const locks = catalog.tables.map(table => relation(table.name)).sort().join(', ')
  const deletes = targets.map(target => `DELETE FROM ${relation(target.table)} AS r WHERE ${predicate(target, catalog, 'r')};\n GET DIAGNOSTICS affected = ROW_COUNT;\n IF affected<>1 THEN RAISE EXCEPTION 'SUPREMO_DELETE_COUNT'; END IF;`).join('\n ')
  return `BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '8s';
${canonicalSettings}
LOCK TABLE ${locks} IN ACCESS EXCLUSIVE MODE;
DO $supremo_delete$
DECLARE catalog_now jsonb; current_snapshot jsonb; affected bigint;
BEGIN
 SELECT c.catalog INTO catalog_now FROM (${catalogQuery(targets)}) c;
 IF catalog_now IS DISTINCT FROM ${json(catalog)} OR pg_catalog.current_setting('session_replication_role')<>'origin' THEN RAISE EXCEPTION 'SUPREMO_DELETE_CHANGED'; END IF;
 SELECT s.snapshot INTO current_snapshot FROM (${snapshotQuery(targets, catalog)}) s;
 IF (current_snapshot->>'undeclaredDependencies')::integer>0 THEN RAISE EXCEPTION 'SUPREMO_DELETE_DEPENDENCIES'; END IF;
 IF current_snapshot IS DISTINCT FROM ${json(snapshot)} THEN RAISE EXCEPTION 'SUPREMO_DELETE_CHANGED'; END IF;
 ${deletes}
END
$supremo_delete$;
SELECT ${targets.length}::integer AS "deletedCount";
COMMIT;`
}
