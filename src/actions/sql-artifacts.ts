'use server'
import { z } from 'zod'
import { requireProjectOwner, requireUser } from '@/lib/auth'
import { createServiceClient } from '@/lib/supabase/admin'
import { prepareSqlArtifact, sqlArtifactStatus } from '@/lib/sql-artifacts/server'
import { prepareSqlArtifactSchema, SqlArtifactError, type SqlArtifactSummary } from '@/lib/sql-artifacts/contract'
import { OperationError } from '@/lib/backend-operations/contract'
import { UnsafeSqlError } from '@/lib/database/sql-guard'

export type SqlArtifactActionResult = { ok: true; executorAvailable: boolean; artifacts: SqlArtifactSummary[] } | { ok: false; error: string }
const identity = prepareSqlArtifactSchema.omit({ content: true })
export async function projectSqlArtifacts(raw: unknown): Promise<SqlArtifactActionResult> {
  try {
    const input = identity.parse(raw), { user } = await requireProjectOwner(input.projectId, 'id,user_id')
    return { ok: true, ...await sqlArtifactStatus({ ...input, client: createServiceClient(), ownerId: user.id, verifyIdentity: async () => (await requireUser()).user.id }) }
  } catch { return { ok: false, error: 'Não foi possível consultar as alterações. Confira a sessão e as migrations do motor.' } }
}
export async function prepareProjectSql(raw: unknown): Promise<SqlArtifactActionResult> {
  try {
    const input = prepareSqlArtifactSchema.parse(raw), { user } = await requireProjectOwner(input.projectId, 'id,user_id')
    return { ok: true, ...await prepareSqlArtifact({ ...input, client: createServiceClient(), ownerId: user.id, ownerSession: true, verifyIdentity: async () => (await requireUser()).user.id }, input) }
  } catch (error) {
    return { ok: false, error: error instanceof SqlArtifactError || error instanceof OperationError || error instanceof UnsafeSqlError ? error.message : error instanceof z.ZodError ? 'Confira o projeto, banco e SQL da migration.' : 'Migration recusada ou preparação indisponível. Nenhum SQL avulso foi executado.' }
  }
}
