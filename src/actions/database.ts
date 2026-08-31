'use server'

import { z } from 'zod'
import { requireProjectOwner, toActionError } from '@/lib/auth'
import { decryptToken } from '@/lib/crypto'
import { assertSafeDataChange } from '@/lib/mcp/sql-guard'
import {
  listTables,
  tableColumns,
  tablePolicies,
  tableRows,
  listEdgeFunctions,
  safeIdent,
  type TableInfo,
  type ColumnInfo,
  type PolicyInfo,
  type TableRows,
  type EdgeFunctionInfo,
} from '@/lib/db-introspect'

/**
 * A aba do banco dentro do Supremo — read-only.
 *
 * Usa o token da conta Supabase do projeto para introspecção pela Management
 * API. Toda action começa por requireProjectOwner, então só o dono vê o
 * próprio banco. Nada aqui escreve.
 */

const PROJECT_COLUMNS = 'id, user_id, supabase_account_id, supabase_project_ref'

/** Resolve o token e o ref do Supabase do projeto, ou explica o que falta. */
async function resolveSupabase(
  projectId: string,
): Promise<
  { ok: true; token: string; ref: string } | { ok: false; error: string }
> {
  const { user, supabase, project } = await requireProjectOwner(
    projectId,
    PROJECT_COLUMNS,
  )

  const ref = project.supabase_project_ref as string | null
  const accountId = project.supabase_account_id as string | null
  if (!ref || !accountId) {
    return { ok: false, error: 'Projeto sem banco Supabase vinculado.' }
  }

  const { data: account } = await supabase
    .from('supabase_accounts')
    .select('access_token_encrypted')
    .eq('id', accountId)
    .eq('user_id', user.id)
    .maybeSingle()

  if (!account) return { ok: false, error: 'Conta Supabase não encontrada.' }

  return {
    ok: true,
    token: decryptToken(account.access_token_encrypted as string),
    ref,
  }
}

export interface DatabaseOverview {
  tables: TableInfo[]
  functions: EdgeFunctionInfo[]
}

export async function getDatabaseOverview(
  projectId: string,
): Promise<{ data?: DatabaseOverview; error?: string }> {
  if (!z.string().uuid().safeParse(projectId).success) {
    return { error: 'ID inválido.' }
  }

  try {
    const creds = await resolveSupabase(projectId)
    if (!creds.ok) return { error: creds.error }

    const [tables, functions] = await Promise.all([
      listTables(creds.token, creds.ref),
      listEdgeFunctions(creds.token, creds.ref),
    ])

    return { data: { tables, functions } }
  } catch (error) {
    return { error: toActionError(error) }
  }
}

export interface TableDetail {
  columns: ColumnInfo[]
  policies: PolicyInfo[]
  data: TableRows
}

export async function getTableDetail(
  projectId: string,
  table: string,
): Promise<{ data?: TableDetail; error?: string }> {
  if (!z.string().uuid().safeParse(projectId).success) {
    return { error: 'ID inválido.' }
  }
  if (!/^[a-z_][a-z0-9_]*$/i.test(table)) {
    return { error: 'Nome de tabela inválido.' }
  }

  try {
    const creds = await resolveSupabase(projectId)
    if (!creds.ok) return { error: creds.error }

    const [columns, policies, data] = await Promise.all([
      tableColumns(creds.token, creds.ref, table),
      tablePolicies(creds.token, creds.ref, table),
      tableRows(creds.token, creds.ref, table),
    ])

    return { data: { columns, policies, data } }
  } catch (error) {
    return { error: toActionError(error) }
  }
}

// ─────────────────────────────────────────────────────────────
// Escrita — fase 2: editar dado direto na aba
//
// Só DADO, com o mesmo guard do apply_data_change do MCP: nada de estrutura,
// e todo UPDATE/DELETE amarrado à chave primária (um WHERE que pega exatamente
// uma linha). O identificador passa por safeIdent; o valor vira literal com
// aspas escapadas — a combinação fecha injeção por nome e por valor.
// ─────────────────────────────────────────────────────────────

const SUPABASE_API = 'https://api.supabase.com'

/** Literal SQL seguro: NULL, ou string com aspas duplicadas. */
function sqlLiteral(value: string | null): string {
  if (value === null) return 'NULL'
  return "'" + value.replace(/'/g, "''") + "'"
}

async function runWrite(
  token: string,
  projectRef: string,
  sql: string,
): Promise<void> {
  assertSafeDataChange(sql)

  const response = await fetch(
    `${SUPABASE_API}/v1/projects/${projectRef}/database/query`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      cache: 'no-store',
      body: JSON.stringify({ query: sql }),
    },
  )

  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => null)
    const message =
      payload && typeof payload === 'object' && 'message' in payload
        ? String((payload as { message: unknown }).message)
        : 'O banco recusou a alteração.'
    throw new Error(message)
  }
}

const ident = z.string().regex(/^[a-z_][a-z0-9_]*$/i, 'Identificador inválido.')

export async function updateCell(input: {
  projectId: string
  table: string
  pkColumn: string
  pkValue: string
  column: string
  value: string | null
}): Promise<{ error?: string }> {
  const parsed = z
    .object({
      projectId: z.string().uuid(),
      table: ident,
      pkColumn: ident,
      pkValue: z.string(),
      column: ident,
      value: z.string().nullable(),
    })
    .safeParse(input)
  if (!parsed.success) return { error: 'Dados inválidos.' }

  try {
    const creds = await resolveSupabase(parsed.data.projectId)
    if (!creds.ok) return { error: creds.error }

    const { table, pkColumn, pkValue, column, value } = parsed.data
    const sql =
      `UPDATE public."${safeIdent(table)}" ` +
      `SET "${safeIdent(column)}" = ${sqlLiteral(value)} ` +
      `WHERE "${safeIdent(pkColumn)}" = ${sqlLiteral(pkValue)}`

    await runWrite(creds.token, creds.ref, sql)
    return {}
  } catch (error) {
    return { error: toActionError(error) }
  }
}

export async function insertRow(input: {
  projectId: string
  table: string
  /** Só as colunas que o usuário preencheu. Coluna omitida usa o default do
   *  banco (id, created_at) — por isso não mandamos a tabela inteira. */
  values: Record<string, string | null>
}): Promise<{ error?: string }> {
  const parsed = z
    .object({
      projectId: z.string().uuid(),
      table: ident,
      values: z.record(z.string(), z.string().nullable()),
    })
    .safeParse(input)
  if (!parsed.success) return { error: 'Dados inválidos.' }

  const columns = Object.keys(parsed.data.values)
  if (columns.length === 0) return { error: 'Nada para inserir.' }
  // Cada nome de coluna também passa pelo mesmo filtro de identificador.
  if (!columns.every((c) => ident.safeParse(c).success)) {
    return { error: 'Nome de coluna inválido.' }
  }

  try {
    const creds = await resolveSupabase(parsed.data.projectId)
    if (!creds.ok) return { error: creds.error }

    const { table, values } = parsed.data
    const cols = columns.map((c) => `"${safeIdent(c)}"`).join(', ')
    const vals = columns.map((c) => sqlLiteral(values[c] ?? null)).join(', ')
    const sql = `INSERT INTO public."${safeIdent(table)}" (${cols}) VALUES (${vals})`

    await runWrite(creds.token, creds.ref, sql)
    return {}
  } catch (error) {
    return { error: toActionError(error) }
  }
}

export async function deleteRow(input: {
  projectId: string
  table: string
  pkColumn: string
  pkValue: string
}): Promise<{ error?: string }> {
  const parsed = z
    .object({
      projectId: z.string().uuid(),
      table: ident,
      pkColumn: ident,
      pkValue: z.string(),
    })
    .safeParse(input)
  if (!parsed.success) return { error: 'Dados inválidos.' }

  try {
    const creds = await resolveSupabase(parsed.data.projectId)
    if (!creds.ok) return { error: creds.error }

    const { table, pkColumn, pkValue } = parsed.data
    const sql =
      `DELETE FROM public."${safeIdent(table)}" ` +
      `WHERE "${safeIdent(pkColumn)}" = ${sqlLiteral(pkValue)}`

    await runWrite(creds.token, creds.ref, sql)
    return {}
  } catch (error) {
    return { error: toActionError(error) }
  }
}
