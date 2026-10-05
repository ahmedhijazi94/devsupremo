import { z } from 'zod'
import {
  mutationActionSchema,
  mutationIdentifier,
  MutationError,
  type MutationAction,
} from './contract'
import { inspectSelectSql } from '../database-inspection/sql'

const name = z.string().min(1).max(63)
export const mutationCatalogSchema = z
  .object({
    oid: z.number().int().positive(),
    table: name,
    kind: z.literal('r'),
    rls: z.literal(true),
    ordinary: z.literal(true),
    columns: z
      .array(
        z
          .object({
            name,
            type: name,
            schema: name,
            kind: z.string(),
            generated: z.string(),
            safeOutput: z.boolean(),
            defaultSql: z.string().nullable(),
            collation: z.string().nullable(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
    primaryKey: z.array(name).min(1).max(8),
    primaryKeyImmediate: z.literal(true),
    foreignKeyColumns: z.array(name),
    checks: z.array(z.string()).max(100),
    indexes: z
      .array(
        z
          .object({
            definition: z.string(),
            safe: z.boolean(),
            expression: z.string().nullable(),
            predicate: z.string().nullable(),
          })
          .strict(),
      )
      .max(100),
    triggers: z
      .array(
        z
          .object({
            name,
            internal: z.boolean(),
            schema: name,
            function: name,
            definer: z.boolean(),
            source: z.string(),
            language: name,
            arguments: z.number().int(),
            returnType: name,
            config: z.array(z.string()).nullable(),
            enabled: z.string(),
          })
          .strict(),
      )
      .max(100),
    rules: z.array(z.string()).max(100),
    dependenciesSafe: z.boolean(),
  })
  .strict()
export type MutationCatalog = z.infer<typeof mutationCatalogSchema>
export const mutationSnapshotSchema = z
  .object({
    catalogFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    rows: z
      .array(
        z
          .object({
            index: z.number().int().min(0).max(24),
            count: z.number().int().min(0).max(1),
            fingerprint: z
              .string()
              .regex(/^[a-f0-9]{64}$/)
              .nullable(),
          })
          .strict(),
      )
      .min(1)
      .max(25),
    ready: z.boolean(),
  })
  .strict()
export type MutationSnapshot = z.infer<typeof mutationSnapshotSchema>
export const sqlValue = (value: string): string =>
  `pg_catalog.convert_from(pg_catalog.decode('${Buffer.from(value, 'utf8').toString('hex')}','hex'),'UTF8')`
const ident = (value: string): string => `"${mutationIdentifier.parse(value)}"`
const relation = (value: string): string => `"public".${ident(value)}`
const json = (value: unknown): string =>
  `${sqlValue(JSON.stringify(value))}::pg_catalog.jsonb`
const hash = (value: string): string =>
  `pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to((${value})::text,'UTF8')),'hex')`
const settings = `SET LOCAL search_path = pg_catalog; SET LOCAL row_security = off; SET LOCAL TimeZone = 'UTC'; SET LOCAL DateStyle = 'ISO, YMD'; SET LOCAL extra_float_digits = 3;`

/** Only catalog identifiers chosen by the server enter this query. The complete
 * catalog is re-read under an exclusive table lock before any application DML. */
export function mutationCatalogQuery(table: string): string {
  mutationIdentifier.parse(table)
  return `WITH target AS (SELECT c.* FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=${sqlValue(table)}),
 objects AS (SELECT 'pg_catalog.pg_constraint'::regclass::oid classid,k.oid objid FROM pg_catalog.pg_constraint k JOIN target c ON c.oid=k.conrelid
 UNION ALL SELECT 'pg_catalog.pg_attrdef'::regclass::oid,a.oid FROM pg_catalog.pg_attrdef a JOIN target c ON c.oid=a.adrelid
 UNION ALL SELECT 'pg_catalog.pg_class'::regclass::oid,i.indexrelid FROM pg_catalog.pg_index i JOIN target c ON c.oid=i.indrelid),
 deps AS (SELECT d.* FROM objects o JOIN pg_catalog.pg_depend d ON d.classid=o.classid AND d.objid=o.objid)
 SELECT pg_catalog.jsonb_build_object(
 'oid',c.oid::integer,'table',c.relname,'kind',c.relkind::text,'rls',c.relrowsecurity,
 'ordinary',NOT c.relispartition AND am.amname='heap' AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_inherits i WHERE i.inhrelid=c.oid OR i.inhparent=c.oid),
 'columns',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('name',a.attname,'type',t.typname,'schema',tn.nspname,'kind',t.typtype::text,'generated',a.attgenerated::text,
 'safeOutput',(tn.nspname='pg_catalog' AND t.typtype='b' AND (t.typelem=0 OR en.nspname='pg_catalog' OR et.typtype='e')) OR t.typtype='e',
 'defaultSql',pg_catalog.pg_get_expr(ad.adbin,ad.adrelid),'collation',cn.nspname) ORDER BY a.attnum)
 FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_type t ON t.oid=a.atttypid JOIN pg_catalog.pg_namespace tn ON tn.oid=t.typnamespace
 LEFT JOIN pg_catalog.pg_type et ON et.oid=t.typelem LEFT JOIN pg_catalog.pg_namespace en ON en.oid=et.typnamespace
 LEFT JOIN pg_catalog.pg_attrdef ad ON ad.adrelid=a.attrelid AND ad.adnum=a.attnum
 LEFT JOIN pg_catalog.pg_collation co ON co.oid=a.attcollation LEFT JOIN pg_catalog.pg_namespace cn ON cn.oid=co.collnamespace WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
 'primaryKey',COALESCE((SELECT pg_catalog.jsonb_agg(a.attname ORDER BY keys.ordinality) FROM pg_catalog.pg_index i CROSS JOIN LATERAL pg_catalog.unnest(i.indkey) WITH ORDINALITY keys(attnum,ordinality) JOIN pg_catalog.pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=keys.attnum WHERE i.indrelid=c.oid AND i.indisprimary AND keys.ordinality<=i.indnkeyatts),'[]'::jsonb),
 'primaryKeyImmediate',COALESCE((SELECT pg_catalog.bool_and(i.indimmediate AND i.indisvalid) FROM pg_catalog.pg_index i WHERE i.indrelid=c.oid AND i.indisprimary),false),
 'foreignKeyColumns',COALESCE((SELECT pg_catalog.jsonb_agg(DISTINCT a.attname) FROM pg_catalog.pg_constraint k JOIN pg_catalog.pg_attribute a ON a.attrelid=k.conrelid AND a.attnum=ANY(k.conkey) WHERE k.conrelid=c.oid AND k.contype='f'),'[]'::jsonb),
 'checks',COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.pg_get_expr(k.conbin,k.conrelid) ORDER BY k.oid) FROM pg_catalog.pg_constraint k WHERE k.conrelid=c.oid AND k.contype='c'),'[]'::jsonb),
 'indexes',COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('definition',pg_catalog.pg_get_indexdef(i.indexrelid),'safe',ia.amname IN ('btree','hash','gin','gist','spgist','brin') AND i.indisvalid AND NOT EXISTS(SELECT 1 FROM pg_catalog.unnest(i.indclass) op(oid) JOIN pg_catalog.pg_opclass oc ON oc.oid=op.oid JOIN pg_catalog.pg_namespace n ON n.oid=oc.opcnamespace WHERE n.nspname<>'pg_catalog'),'expression',pg_catalog.pg_get_expr(i.indexprs,i.indrelid),'predicate',pg_catalog.pg_get_expr(i.indpred,i.indrelid)) ORDER BY i.indexrelid) FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class ic ON ic.oid=i.indexrelid JOIN pg_catalog.pg_am ia ON ia.oid=ic.relam WHERE i.indrelid=c.oid),'[]'::jsonb),
 'triggers',COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('name',tr.tgname,'internal',tr.tgisinternal,'schema',pn.nspname,'function',p.proname,'definer',p.prosecdef,'source',p.prosrc,'language',l.lanname,'arguments',p.pronargs,'returnType',rt.typname,'config',p.proconfig,'enabled',tr.tgenabled::text) ORDER BY tr.oid) FROM pg_catalog.pg_trigger tr JOIN pg_catalog.pg_proc p ON p.oid=tr.tgfoid JOIN pg_catalog.pg_namespace pn ON pn.oid=p.pronamespace JOIN pg_catalog.pg_language l ON l.oid=p.prolang JOIN pg_catalog.pg_type rt ON rt.oid=p.prorettype WHERE tr.tgrelid=c.oid AND (tr.tgtype & 20)<>0),'[]'::jsonb),
 'rules',COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.pg_get_ruledef(r.oid) ORDER BY r.oid) FROM pg_catalog.pg_rewrite r WHERE r.ev_class=c.oid),'[]'::jsonb),
 'dependenciesSafe',NOT EXISTS(SELECT 1 FROM deps d JOIN pg_catalog.pg_proc p ON d.refclassid='pg_catalog.pg_proc'::regclass AND p.oid=d.refobjid JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname<>'pg_catalog')
 AND NOT EXISTS(SELECT 1 FROM deps d JOIN pg_catalog.pg_operator o ON d.refclassid='pg_catalog.pg_operator'::regclass AND o.oid=d.refobjid JOIN pg_catalog.pg_proc p ON p.oid=o.oprcode JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname<>'pg_catalog')) AS catalog
 FROM target c JOIN pg_catalog.pg_am am ON am.oid=c.relam`
}
const scalarTypes = new Set([
  'text',
  'varchar',
  'bpchar',
  'bool',
  'int2',
  'int4',
  'int8',
  'numeric',
  'float4',
  'float8',
  'uuid',
  'timestamp',
  'timestamptz',
  'date',
])
function reject(message: string): never {
  throw new MutationError(message)
}
export function validateMutationCatalog(
  input: MutationAction,
  raw: unknown,
): MutationCatalog {
  const action = mutationActionSchema.parse(input)
  if (action.type === 'delete')
    reject('Use o catálogo de dependências da exclusão.')
  const parsed = mutationCatalogSchema.safeParse(raw)
  if (!parsed.success)
    reject('Operação exige tabela public comum, RLS e chave primária válida.')
  const catalog = parsed.data
  if (
    catalog.table !== action.table ||
    !catalog.dependenciesSafe ||
    catalog.rules.length ||
    catalog.indexes.some((index) => !index.safe)
  )
    reject(
      'Regras, índices ou dependências da tabela não permitem confirmar os efeitos.',
    )
  if (catalog.columns.some((column) => !column.safeOutput))
    reject('Um tipo personalizado tem efeitos de leitura não verificáveis.')
  const expressions = [
    ...catalog.checks,
    ...catalog.indexes
      .flatMap((index) => [index.expression, index.predicate])
      .filter((value): value is string => value !== null),
  ]
  for (const expression of expressions) inspectSelectSql(`SELECT ${expression}`)
  for (const trigger of catalog.triggers) {
    if (
      trigger.internal &&
      trigger.schema === 'pg_catalog' &&
      trigger.function.startsWith('RI_FKey_') &&
      ['O', 'A'].includes(trigger.enabled)
    )
      continue
    const source = trigger.source
      .toLowerCase()
      .replace(/\s+/g, '')
      .replaceAll('pg_catalog.', '')
    if (
      trigger.schema !== 'public' ||
      trigger.function !== 'set_updated_at' ||
      trigger.definer ||
      trigger.language !== 'plpgsql' ||
      trigger.arguments !== 0 ||
      trigger.returnType !== 'trigger' ||
      !['O', 'A'].includes(trigger.enabled) ||
      ![
        'beginnew.updated_at=now();returnnew;end;',
        'beginnew.updated_at:=now();returnnew;end;',
      ].includes(source) ||
      trigger.config?.some(
        (config) =>
          ![
            'search_path=""',
            'search_path=',
            'search_path=pg_catalog, public',
            'search_path=pg_catalog,public',
          ].includes(config),
      )
    )
      reject(
        'Trigger de escrita não suportado; impacto indireto não autorizado.',
      )
  }
  const seen = new Set<string>()
  for (const row of action.rows) {
    if (
      Object.keys(row.key).length !== catalog.primaryKey.length ||
      catalog.primaryKey.some((key) => !Object.hasOwn(row.key, key))
    )
      reject('Informe a chave primária completa de cada linha.')
    const signature = JSON.stringify(
      catalog.primaryKey.map((key) => row.key[key]),
    )
    if (seen.has(signature)) reject('Linhas duplicadas no mesmo plano.')
    seen.add(signature)
    if (Object.keys(row.values).some((key) => catalog.primaryKey.includes(key)))
      reject('Valores não podem substituir a chave primária informada.')
    for (const field of [...catalog.primaryKey, ...Object.keys(row.values)]) {
      const column = catalog.columns.find((item) => item.name === field)
      if (
        !column ||
        column.schema !== 'pg_catalog' ||
        !scalarTypes.has(column.type) ||
        column.generated ||
        (column.collation && column.collation !== 'pg_catalog')
      )
        reject(
          'Campo alterado ou chave tem tipo não suportado; campos preservados podem usar enum, array ou geração segura.',
        )
      if (
        action.type !== 'insert' &&
        !catalog.primaryKey.includes(field) &&
        (catalog.foreignKeyColumns.includes(field) ||
          /^(user_id|owner_id|org_id|organization_id|tenant_id|team_id|created_by)$/i.test(
            field,
          ))
      )
        reject(
          'Atualizar vínculos ou ownership exige operação específica; nada foi alterado.',
        )
    }
    for (const column of catalog.columns) {
      if (
        !column.defaultSql ||
        (!column.generated &&
          (action.type === 'update' ||
            Object.hasOwn(row.key, column.name) ||
            Object.hasOwn(row.values, column.name)))
      )
        continue
      if (
        !/^(?:now\(\)|(?:pg_catalog\.)?gen_random_uuid\(\))$/i.test(
          column.defaultSql,
        )
      )
        inspectSelectSql(`SELECT ${column.defaultSql}`)
    }
  }
  return catalog
}
function predicate(
  key: Record<string, string | number | boolean>,
  catalog: MutationCatalog,
  alias: string,
): string {
  return catalog.primaryKey
    .map(
      (name) =>
        `${alias}.${ident(name)} OPERATOR(pg_catalog.=) ${sqlValue(String(key[name]))}::pg_catalog.${ident(catalog.columns.find((column) => column.name === name)!.type)}`,
    )
    .join(' AND ')
}
function snapshotQuery(
  action: MutationAction,
  catalog: MutationCatalog,
): string {
  const rows = action.rows.map(
    (row, index) =>
      `SELECT ${index} AS index,pg_catalog.count(*)::integer AS count,pg_catalog.min(${hash("pg_catalog.jsonb_build_object('row',pg_catalog.to_jsonb(r),'xmin',r.xmin::text,'oid',r.tableoid::bigint)")}) AS fingerprint FROM ${relation(action.table)} r WHERE ${predicate(row.key, catalog, 'r')}`,
  )
  const expected =
    action.type === 'insert'
      ? 'count=0'
      : action.type === 'update'
        ? 'count=1'
        : 'count IN (0,1)'
  return `WITH c AS (${mutationCatalogQuery(action.table)}),rows AS (${rows.join(' UNION ALL ')}) SELECT pg_catalog.jsonb_build_object('catalogFingerprint',${hash('c.catalog')},'rows',(SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(r) ORDER BY r.index) FROM rows r),'ready',c.catalog=${json(catalog)} AND (SELECT pg_catalog.bool_and(${expected}) FROM rows) AND (SELECT pg_catalog.count(DISTINCT fingerprint)=pg_catalog.count(fingerprint) FROM rows) AND pg_catalog.current_setting('session_replication_role')='origin') AS snapshot FROM c`
}
export function mutationInspectionSql(
  action: MutationAction,
  raw: unknown,
): string {
  const catalog = validateMutationCatalog(action, raw)
  return `${settings} ${snapshotQuery(action, catalog)};`
}
export function mutationApplySql(
  action: MutationAction,
  raw: unknown,
  rawSnapshot: unknown,
): string {
  const catalog = validateMutationCatalog(action, raw),
    snapshot = mutationSnapshotSchema.parse(rawSnapshot)
  if (
    !snapshot.ready ||
    snapshot.rows.length !== action.rows.length ||
    snapshot.rows.some((row, index) => row.index !== index)
  )
    reject('Estado do plano não confirmado.')
  if (action.type === 'delete') reject('Use a exclusão com dependências.')
  const changes = action.rows
    .map((row) => {
      const expression = (
        name: string,
        value: string | number | boolean | null,
      ): string =>
        value === null
          ? 'NULL'
          : `${sqlValue(String(value))}::pg_catalog.${ident(catalog.columns.find((column) => column.name === name)!.type)}`
      const set = Object.entries(row.values)
        .map(([name, value]) => `${ident(name)}=${expression(name, value)}`)
        .join(',')
      if (action.type === 'update')
        return `UPDATE ${relation(action.table)} r SET ${set} WHERE ${predicate(row.key, catalog, 'r')}; GET DIAGNOSTICS affected=ROW_COUNT; IF affected<>1 THEN RAISE EXCEPTION 'SUPREMO_MUTATION_COUNT'; END IF;`
      const fields = { ...row.key, ...row.values }
      return `INSERT INTO ${relation(action.table)} (${Object.keys(fields).map(ident).join(',')}) VALUES (${Object.entries(
        fields,
      )
        .map(([name, value]) => expression(name, value))
        .join(
          ',',
        )})${action.type === 'upsert' ? ` ON CONFLICT (${catalog.primaryKey.map(ident).join(',')}) DO UPDATE SET ${set}` : ''}; GET DIAGNOSTICS affected=ROW_COUNT; IF affected<>1 THEN RAISE EXCEPTION 'SUPREMO_MUTATION_COUNT'; END IF;`
    })
    .join('\n')
  return `BEGIN; SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='8s'; ${settings}
 LOCK TABLE ${relation(action.table)} IN ACCESS EXCLUSIVE MODE;
 DO $supremo_mutation$ DECLARE observed jsonb; affected bigint; BEGIN
 SELECT s.snapshot INTO observed FROM (${snapshotQuery(action, catalog)}) s;
 IF observed IS DISTINCT FROM ${json(snapshot)} THEN RAISE EXCEPTION 'SUPREMO_MUTATION_CHANGED'; END IF;
 ${changes}
 END $supremo_mutation$;
 SELECT ${action.rows.length}::integer AS "affectedCount"; COMMIT;`
}
