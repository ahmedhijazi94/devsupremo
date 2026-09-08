import { z } from 'zod'
import { inspectSelectSql } from '../database-inspection/sql'
import { jobColumnAllowed, type JobDefinition } from './policy'

const dependencySchema = z.object({
  kind: z.string(),
  schema: z.string(),
  name: z.string(),
  definition: z.string(),
})
export const jobTableSchema = z.object({
  oid: z.number().int().positive(),
  name: z.string(),
  kind: z.string(),
  rls: z.boolean(),
  partition: z.boolean(),
  inherits: z.boolean(),
  columns: z.array(
    z.object({
      name: z.string(),
      type: z.string(),
      schema: z.string(),
      kind: z.string(),
      generated: z.string(),
      collation_schema: z.string().nullable(),
    }),
  ),
  primary_key: z.array(z.string()),
  foreign_key_columns: z.array(z.string()),
  checks: z.array(z.string()),
  rules: z.array(z.string()),
  indexes: z.array(
    z.object({
      definition: z.string(),
      method: z.string(),
      expression: z.string().nullable(),
      predicate: z.string().nullable(),
    }),
  ),
  dependencies: z.array(dependencySchema),
  policies: z.array(
    z.object({
      name: z.string(),
      roles: z.array(z.number()),
      roles_names: z.array(z.string()),
      using: z.string().nullable(),
      check: z.string().nullable(),
    }),
  ),
  triggers: z.array(
    z.object({
      name: z.string(),
      internal: z.boolean(),
      function_schema: z.string(),
      function_name: z.string(),
      language: z.string(),
      definer: z.boolean(),
      source: z.string(),
      arguments: z.number(),
      return_type: z.string(),
      config: z.array(z.string()).nullable(),
    }),
  ),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
})
export type JobTable = z.infer<typeof jobTableSchema>
export const quoteIdent = (name: string) => `"${name.replaceAll('"', '""')}"`
// Explicit E literals remain safe regardless of standard_conforming_strings.
export const quoteLiteral = (value: string) =>
  `E'${value.replaceAll('\\', '\\\\').replaceAll("'", "''")}'`

// Only exact engine policies are omitted from the structural fingerprint. A
// prefix alone never exempts an application/PUBLIC policy from verification.
const managedPolicy = `p.polname ~ '^supremo_job_[a-f0-9]{24}_(select|update)$' AND p.polpermissive AND cardinality(p.polroles)=1
 AND EXISTS(SELECT 1 FROM pg_catalog.pg_roles r WHERE r.oid=p.polroles[1] AND r.rolname=regexp_replace(p.polname,'_(select|update)$','') AND NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcanlogin AND NOT r.rolinherit AND NOT r.rolcreaterole AND NOT r.rolcreatedb AND NOT r.rolreplication)
 AND pg_catalog.pg_get_expr(p.polqual,p.polrelid)='true' AND ((p.polcmd='r' AND p.polwithcheck IS NULL AND p.polname LIKE '%_select') OR (p.polcmd='w' AND pg_catalog.pg_get_expr(p.polwithcheck,p.polrelid)='true' AND p.polname LIKE '%_update'))`

export function tableCatalogSql(table: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(table))
    throw new Error('Tabela inválida.')
  return `WITH target AS (SELECT c.* FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=${quoteLiteral(table)}),
 objects AS (SELECT 'pg_catalog.pg_constraint'::regclass::oid classid,k.oid objid FROM pg_catalog.pg_constraint k JOIN target c ON k.conrelid=c.oid
 UNION ALL SELECT 'pg_catalog.pg_class'::regclass::oid,i.indexrelid FROM pg_catalog.pg_index i JOIN target c ON i.indrelid=c.oid
 UNION ALL SELECT 'pg_catalog.pg_policy'::regclass::oid,p.oid FROM pg_catalog.pg_policy p JOIN target c ON p.polrelid=c.oid WHERE (0=ANY(p.polroles) OR EXISTS(SELECT 1 FROM pg_catalog.pg_roles ar WHERE ar.oid=ANY(p.polroles) AND ar.rolname ~ '^supremo_job_[a-f0-9]{24}$')) AND NOT (${managedPolicy})
 UNION ALL SELECT 'pg_catalog.pg_attrdef'::regclass::oid,a.oid FROM pg_catalog.pg_attrdef a JOIN target c ON a.adrelid=c.oid),
 deps AS (SELECT DISTINCT d.refclassid,d.refobjid FROM objects o JOIN pg_catalog.pg_depend d ON d.classid=o.classid AND d.objid=o.objid),
 resolved AS (
 SELECT 'function' AS kind,n.nspname AS schema,p.proname AS name,p.prosrc||COALESCE(p.proconfig::text,'')||p.prosecdef::text||p.prolang::text AS definition FROM deps d JOIN pg_catalog.pg_proc p ON d.refclassid='pg_catalog.pg_proc'::regclass AND p.oid=d.refobjid JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
 UNION ALL SELECT 'type',n.nspname,t.typname,t.oid::text FROM deps d JOIN pg_catalog.pg_type t ON d.refclassid='pg_catalog.pg_type'::regclass AND t.oid=d.refobjid JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace
 UNION ALL SELECT 'collation',n.nspname,t.collname,t.oid::text FROM deps d JOIN pg_catalog.pg_collation t ON d.refclassid='pg_catalog.pg_collation'::regclass AND t.oid=d.refobjid JOIN pg_catalog.pg_namespace n ON n.oid=t.collnamespace
 UNION ALL SELECT 'operator',n.nspname,t.oprname,t.oprcode::text FROM deps d JOIN pg_catalog.pg_operator t ON d.refclassid='pg_catalog.pg_operator'::regclass AND t.oid=d.refobjid JOIN pg_catalog.pg_namespace n ON n.oid=t.oprnamespace
 UNION ALL SELECT 'opclass',n.nspname,t.opcname,t.oid::text FROM deps d JOIN pg_catalog.pg_opclass t ON d.refclassid='pg_catalog.pg_opclass'::regclass AND t.oid=d.refobjid JOIN pg_catalog.pg_namespace n ON n.oid=t.opcnamespace),
 metadata AS (SELECT c.oid::integer AS oid,c.relname AS name,c.relkind::text AS kind,c.relrowsecurity AS rls,c.relispartition AS partition,
 EXISTS(SELECT 1 FROM pg_catalog.pg_inherits inh WHERE inh.inhrelid=c.oid OR inh.inhparent=c.oid) AS inherits,
 COALESCE((SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',t.typname,'schema',ns.nspname,'kind',t.typtype::text,'generated',a.attgenerated::text,'collation_schema',cn.nspname) ORDER BY a.attnum)
 FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_type t ON t.oid=a.atttypid JOIN pg_catalog.pg_namespace ns ON ns.oid=t.typnamespace LEFT JOIN pg_catalog.pg_collation co ON co.oid=a.attcollation LEFT JOIN pg_catalog.pg_namespace cn ON cn.oid=co.collnamespace
 WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),'[]'::jsonb) AS columns,
 COALESCE((SELECT jsonb_agg(a.attname ORDER BY a.attnum) FROM pg_catalog.pg_index i JOIN pg_catalog.pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=ANY(i.indkey) WHERE i.indrelid=c.oid AND i.indisprimary AND i.indisvalid),'[]'::jsonb) AS primary_key,
 COALESCE((SELECT jsonb_agg(DISTINCT a.attname) FROM pg_catalog.pg_constraint k JOIN pg_catalog.pg_attribute a ON a.attrelid=k.conrelid AND a.attnum=ANY(k.conkey) WHERE k.conrelid=c.oid AND k.contype='f'),'[]'::jsonb) AS foreign_key_columns,
 COALESCE((SELECT jsonb_agg(pg_catalog.pg_get_expr(k.conbin,k.conrelid) ORDER BY k.oid) FROM pg_catalog.pg_constraint k WHERE k.conrelid=c.oid AND k.contype='c'),'[]'::jsonb) AS checks,
 COALESCE((SELECT jsonb_agg(pg_catalog.pg_get_ruledef(r.oid) ORDER BY r.oid) FROM pg_catalog.pg_rewrite r WHERE r.ev_class=c.oid),'[]'::jsonb) AS rules,
 COALESCE((SELECT jsonb_agg(jsonb_build_object('definition',pg_catalog.pg_get_indexdef(i.indexrelid),'method',am.amname,'expression',pg_catalog.pg_get_expr(i.indexprs,i.indrelid),'predicate',pg_catalog.pg_get_expr(i.indpred,i.indrelid)) ORDER BY i.indexrelid) FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class ic ON ic.oid=i.indexrelid JOIN pg_catalog.pg_am am ON am.oid=ic.relam WHERE i.indrelid=c.oid),'[]'::jsonb) AS indexes,
 COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.kind,r.schema,r.name,r.definition) FROM resolved r),'[]'::jsonb) AS dependencies,
 COALESCE((SELECT jsonb_agg(jsonb_build_object('name',p.polname,'roles',p.polroles::bigint[],'roles_names',COALESCE((SELECT jsonb_agg(ar.rolname ORDER BY ar.rolname) FROM pg_catalog.pg_roles ar WHERE ar.oid=ANY(p.polroles)),'[]'::jsonb),'using',pg_catalog.pg_get_expr(p.polqual,p.polrelid),'check',pg_catalog.pg_get_expr(p.polwithcheck,p.polrelid)) ORDER BY p.oid) FROM pg_catalog.pg_policy p WHERE p.polrelid=c.oid AND NOT (${managedPolicy})),'[]'::jsonb) AS policies,
 COALESCE((SELECT jsonb_agg(jsonb_build_object('name',tr.tgname,'internal',tr.tgisinternal,'function_schema',pn.nspname,'function_name',p.proname,'language',l.lanname,'definer',p.prosecdef,'source',p.prosrc,'arguments',p.pronargs,'return_type',rt.typname,'config',p.proconfig) ORDER BY tr.oid)
 FROM pg_catalog.pg_trigger tr JOIN pg_catalog.pg_proc p ON p.oid=tr.tgfoid JOIN pg_catalog.pg_namespace pn ON pn.oid=p.pronamespace JOIN pg_catalog.pg_language l ON l.oid=p.prolang JOIN pg_catalog.pg_type rt ON rt.oid=p.prorettype WHERE tr.tgrelid=c.oid AND tr.tgenabled<>'D'),'[]'::jsonb) AS triggers
 FROM target c) SELECT metadata.*,pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.to_jsonb(metadata)::text,'UTF8')),'hex') AS fingerprint FROM metadata`
}

const TYPES = new Set([
  'text',
  'varchar',
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
  'jsonb',
  'json',
])
export function validateJobTable(job: JobDefinition, input: unknown): JobTable {
  const table = jobTableSchema.parse(input)
  if (
    table.name !== job.action.table ||
    table.kind !== 'r' ||
    !table.rls ||
    table.partition ||
    table.inherits ||
    table.primary_key.length !== 1 ||
    table.rules.length > 0
  )
    throw new Error(
      'Job exige tabela public comum com RLS e chave primária simples.',
    )
  for (const column of table.columns)
    if (
      column.schema !== 'pg_catalog' ||
      column.kind !== 'b' ||
      !TYPES.has(column.type) ||
      column.generated ||
      (column.collation_schema !== null &&
        column.collation_schema !== 'pg_catalog')
    )
      throw new Error(
        'Tipo, collation ou coluna calculada não suportado pela rotina declarativa.',
      )
  const needed = new Set([
    table.primary_key[0]!,
    ...Object.keys(job.action.set),
    ...job.action.where.map((value) => value.column),
  ])
  for (const name of needed)
    if (
      !jobColumnAllowed(name) ||
      !table.columns.some(
        (column) =>
          column.name === name && !['json', 'jsonb'].includes(column.type),
      )
    )
      throw new Error(
        'Campo ausente ou tipo não suportado pela rotina declarativa.',
      )
  for (const name of Object.keys(job.action.set))
    if (
      !jobColumnAllowed(name, true) ||
      table.primary_key.includes(name) ||
      table.foreign_key_columns.includes(name)
    )
      throw new Error(
        'Rotinas não alteram chaves, vínculos, ownership, permissões ou credenciais.',
      )
  for (const condition of job.action.where)
    if (
      condition.op === 'older_than' &&
      !['timestamp', 'timestamptz', 'date'].includes(
        table.columns.find((column) => column.name === condition.column)!.type,
      )
    )
      throw new Error('older_than exige coluna de data ou horário.')
  // Dependencies are resolved by PostgreSQL, not guessed from expression text.
  // Builtin operators/casts execute only after SET ROLE; external code is denied.
  if (
    table.dependencies.some(
      (dependency) => dependency.schema !== 'pg_catalog',
    ) ||
    table.indexes.some((index) => index.method !== 'btree')
  )
    throw new Error(
      'Constraints, políticas ou índices dependem de código externo não suportado.',
    )
  const expressionSafe = (expression: string) =>
    inspectSelectSql(`SELECT ${expression.replace(/\bANY\s*\(/gi, '(')}`)
  for (const expression of table.checks) expressionSafe(expression)
  for (const index of table.indexes)
    for (const expression of [index.expression, index.predicate])
      if (expression) expressionSafe(expression)
  for (const policy of table.policies)
    if (
      policy.roles.includes(0) ||
      policy.roles_names.some((name) => /^supremo_job_[a-f0-9]{24}$/.test(name))
    )
      for (const expression of [policy.using, policy.check])
        if (expression) expressionSafe(expression)
  for (const trigger of table.triggers) {
    if (
      trigger.internal &&
      trigger.function_schema === 'pg_catalog' &&
      ['internal', 'c'].includes(trigger.language) &&
      trigger.function_name.startsWith('RI_FKey_')
    )
      continue
    const source = trigger.source
      .toLowerCase()
      .replace(/\s+/g, '')
      .replaceAll('pg_catalog.', '')
    const configSafe =
      trigger.config === null ||
      (trigger.config.length === 1 &&
        trigger.config[0]!.replace(/\s+/g, '') ===
          'search_path=pg_catalog,public')
    if (
      trigger.function_schema !== 'public' ||
      trigger.function_name !== 'set_updated_at' ||
      trigger.language !== 'plpgsql' ||
      trigger.definer ||
      !configSafe ||
      trigger.arguments !== 0 ||
      trigger.return_type !== 'trigger' ||
      (source !== 'beginnew.updated_at=now();returnnew;end;' &&
        source !== 'beginnew.updated_at:=now();returnnew;end;')
    )
      throw new Error(
        'Trigger não suportado. A rotina aceita somente updated_at padrão, com search_path seguro.',
      )
  }
  return table
}
