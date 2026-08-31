/**
 * Introspecção read-only do banco de um projeto.
 *
 * Roda pela Management API do Supabase (/database/query), sempre dentro de uma
 * transação READ ONLY — o mesmo caminho que o execute_sql do MCP usa. As
 * queries de introspecção são fixas e escritas aqui; os únicos valores que
 * vêm de fora são nomes de tabela/coluna, e esses passam por safeIdent antes
 * de tocar no SQL. Nada aqui escreve.
 */

const SUPABASE_API = 'https://api.supabase.com'

export interface ColumnInfo {
  name: string
  type: string
  nullable: boolean
  default: string | null
  isPrimaryKey: boolean
}

export interface PolicyInfo {
  name: string
  command: string
  roles: string
  using: string | null
  withCheck: string | null
}

export interface TableInfo {
  name: string
  rowCount: number
  rlsEnabled: boolean
}

export interface EdgeFunctionInfo {
  name: string
  slug: string
  status: string
  updatedAt: number | null
}

/**
 * Um identificador de tabela ou coluna aceitável.
 *
 * A lista de tabelas vem do próprio banco, mas validar de novo aqui fecha
 * qualquer caminho de injeção por nome — o valor só entra no SQL depois disto.
 */
export function safeIdent(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) {
    throw new Error(`Identificador inválido: ${name}`)
  }
  return name
}

/** Executa SQL de leitura, forçado a READ ONLY pelo próprio Postgres. */
async function runReadOnly(
  token: string,
  projectRef: string,
  sql: string,
): Promise<unknown[]> {
  const response = await fetch(
    `${SUPABASE_API}/v1/projects/${projectRef}/database/query`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      cache: 'no-store',
      body: JSON.stringify({ query: `BEGIN READ ONLY;\n${sql}` }),
    },
  )

  const payload: unknown = await response.json()
  if (!response.ok) {
    const message =
      typeof payload === 'object' && payload && 'message' in payload
        ? String((payload as { message: unknown }).message)
        : JSON.stringify(payload)
    throw new Error(message)
  }

  return Array.isArray(payload) ? payload : []
}

/** Tabelas do schema public, com contagem de linhas e estado do RLS. */
export async function listTables(
  token: string,
  projectRef: string,
): Promise<TableInfo[]> {
  const rows = (await runReadOnly(
    token,
    projectRef,
    `SELECT c.relname AS name,
            c.relrowsecurity AS rls,
            COALESCE(s.n_live_tup, 0) AS approx_rows
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
      WHERE n.nspname = 'public' AND c.relkind = 'r'
      ORDER BY c.relname`,
  )) as Array<{ name: string; rls: boolean; approx_rows: number | string }>

  return rows.map((row) => ({
    name: row.name,
    rlsEnabled: Boolean(row.rls),
    rowCount: Number(row.approx_rows) || 0,
  }))
}

/** Colunas de uma tabela, marcando a chave primária. */
export async function tableColumns(
  token: string,
  projectRef: string,
  table: string,
): Promise<ColumnInfo[]> {
  const safe = safeIdent(table)
  const rows = (await runReadOnly(
    token,
    projectRef,
    `SELECT col.column_name AS name,
            col.data_type AS type,
            col.is_nullable AS nullable,
            col.column_default AS "default",
            CASE WHEN pk.column_name IS NOT NULL THEN true ELSE false END AS is_pk
       FROM information_schema.columns col
       LEFT JOIN (
         SELECT kcu.column_name
           FROM information_schema.table_constraints tc
           JOIN information_schema.key_column_usage kcu
             ON kcu.constraint_name = tc.constraint_name
          WHERE tc.table_schema = 'public'
            AND tc.table_name = '${safe}'
            AND tc.constraint_type = 'PRIMARY KEY'
       ) pk ON pk.column_name = col.column_name
      WHERE col.table_schema = 'public' AND col.table_name = '${safe}'
      ORDER BY col.ordinal_position`,
  )) as Array<{
    name: string
    type: string
    nullable: string
    default: string | null
    is_pk: boolean
  }>

  return rows.map((row) => ({
    name: row.name,
    type: row.type,
    nullable: row.nullable === 'YES',
    default: row.default,
    isPrimaryKey: Boolean(row.is_pk),
  }))
}

/** Policies de RLS de uma tabela — a prova visível do isolamento. */
export async function tablePolicies(
  token: string,
  projectRef: string,
  table: string,
): Promise<PolicyInfo[]> {
  const safe = safeIdent(table)
  const rows = (await runReadOnly(
    token,
    projectRef,
    `SELECT policyname AS name, cmd, roles::text AS roles, qual, with_check
       FROM pg_policies
      WHERE schemaname = 'public' AND tablename = '${safe}'
      ORDER BY policyname`,
  )) as Array<{
    name: string
    cmd: string
    roles: string
    qual: string | null
    with_check: string | null
  }>

  return rows.map((row) => ({
    name: row.name,
    command: row.cmd,
    roles: row.roles,
    using: row.qual,
    withCheck: row.with_check,
  }))
}

export interface TableRows {
  columns: string[]
  rows: Array<Record<string, unknown>>
}

/** Primeiras linhas de uma tabela, para inspeção. Read-only, limite fixo. */
export async function tableRows(
  token: string,
  projectRef: string,
  table: string,
  limit = 50,
): Promise<TableRows> {
  const safe = safeIdent(table)
  const capped = Math.min(Math.max(1, limit), 200)
  const rows = (await runReadOnly(
    token,
    projectRef,
    `SELECT * FROM public."${safe}" LIMIT ${capped}`,
  )) as Array<Record<string, unknown>>

  const columns = rows.length > 0 ? Object.keys(rows[0]!) : []
  return { columns, rows }
}

/** Edge Functions do projeto, pela Management API. */
export async function listEdgeFunctions(
  token: string,
  projectRef: string,
): Promise<EdgeFunctionInfo[]> {
  const response = await fetch(
    `${SUPABASE_API}/v1/projects/${projectRef}/functions`,
    {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
    },
  )
  if (!response.ok) return []

  const data = (await response.json()) as Array<{
    name?: string
    slug?: string
    status?: string
    updated_at?: number
  }>
  if (!Array.isArray(data)) return []

  return data.map((fn) => ({
    name: fn.name ?? fn.slug ?? 'sem nome',
    slug: fn.slug ?? '',
    status: fn.status ?? 'desconhecido',
    updatedAt: fn.updated_at ?? null,
  }))
}
