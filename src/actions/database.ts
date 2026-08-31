'use server'

import { z } from 'zod'
import { requireProjectOwner, toActionError } from '@/lib/auth'
import { decryptToken } from '@/lib/crypto'
import {
  listTables,
  tableColumns,
  tablePolicies,
  tableRows,
  listEdgeFunctions,
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
