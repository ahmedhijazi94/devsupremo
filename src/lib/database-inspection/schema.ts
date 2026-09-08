import { SENSITIVE_IDENTIFIER_PATTERN } from './sensitive'

/** Fixed catalog query; untrusted SQL cannot access catalog/credential tables.
 * Each row is one relation; nested collections have their own caps, disclosed
 * by *_count and *_truncated. Counts of application rows are approximate. */
export function schemaInspectionSql(
  limit: number,
  offset: number,
  table?: string,
): string {
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 200 ||
    !Number.isInteger(offset) ||
    offset < 0 ||
    offset > 10000 ||
    (table && !/^[a-z_][a-z0-9_]{0,62}$/i.test(table))
  ) {
    throw new Error('Limites ou tabela inválidos.')
  }
  return `SELECT c.relname AS name, 'public' AS schema,
  CASE c.relkind WHEN 'r' THEN 'table' WHEN 'p' THEN 'partitioned_table' WHEN 'v' THEN 'view' ELSE 'materialized_view' END AS kind,
  c.relrowsecurity AS rls_enabled, c.relforcerowsecurity AS rls_forced,
  COALESCE(s.n_live_tup, 0) AS approximate_rows,
  (SELECT count(*) FROM pg_catalog.pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped) AS columns_count,
  (SELECT json_agg(x) FROM (SELECT a.attname AS name, pg_catalog.format_type(a.atttypid,a.atttypmod) AS type,
    NOT a.attnotnull AS nullable,
    CASE WHEN a.attname ~* '${SENSITIVE_IDENTIFIER_PATTERN}'
      THEN NULL ELSE pg_catalog.pg_get_expr(d.adbin,d.adrelid) END AS default_expression
    FROM pg_catalog.pg_attribute a LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum LIMIT 100) x) AS columns,
  (SELECT count(*) FROM pg_catalog.pg_index i WHERE i.indrelid=c.oid) AS indexes_count,
  (SELECT json_agg(x) FROM (SELECT ci.relname AS name, i.indisprimary AS primary_key, i.indisunique AS unique_index,
    pg_catalog.pg_get_indexdef(i.indexrelid) AS definition FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class ci ON ci.oid=i.indexrelid
    WHERE i.indrelid=c.oid ORDER BY ci.relname LIMIT 100) x) AS indexes,
  (SELECT count(*) FROM pg_catalog.pg_constraint k WHERE k.conrelid=c.oid AND k.contype='f') AS foreign_keys_count,
  (SELECT json_agg(x) FROM (SELECT k.conname AS name, pg_catalog.pg_get_constraintdef(k.oid) AS definition,
    tn.nspname AS target_schema, tc.relname AS target_table FROM pg_catalog.pg_constraint k
    JOIN pg_catalog.pg_class tc ON tc.oid=k.confrelid JOIN pg_catalog.pg_namespace tn ON tn.oid=tc.relnamespace
    WHERE k.conrelid=c.oid AND k.contype='f' ORDER BY k.conname LIMIT 100) x) AS foreign_keys,
  (SELECT count(*) FROM pg_catalog.pg_policies p WHERE p.schemaname='public' AND p.tablename=c.relname) AS policies_count,
  (SELECT json_agg(x) FROM (SELECT p.policyname AS name,p.permissive,p.roles,p.cmd AS command,p.qual AS using_expression,p.with_check AS check_expression
    FROM pg_catalog.pg_policies p WHERE p.schemaname='public' AND p.tablename=c.relname ORDER BY p.policyname LIMIT 100) x) AS policies
FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
LEFT JOIN pg_catalog.pg_stat_user_tables s ON s.relid=c.oid
WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m')${table ? ` AND c.relname='${table}'` : ''}
ORDER BY c.relname LIMIT ${limit + 1} OFFSET ${offset}`
}

export const diagnosticsSql = `SELECT
  pg_catalog.current_database() AS database_name, CURRENT_USER AS database_role,
  pg_catalog.current_setting('transaction_read_only') AS transaction_read_only,
  pg_catalog.current_setting('statement_timeout') AS statement_timeout,
  pg_catalog.pg_database_size(pg_catalog.current_database()) AS database_bytes,
  (SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p') AND NOT c.relrowsecurity) AS tables_without_rls,
  (SELECT count(*) FROM pg_catalog.pg_stat_activity WHERE datname=pg_catalog.current_database()) AS connections,
  (SELECT count(*) FROM pg_catalog.pg_stat_activity WHERE datname=pg_catalog.current_database() AND wait_event_type='Lock') AS waiting_for_lock`
