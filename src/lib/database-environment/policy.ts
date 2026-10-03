import { z } from 'zod'
import { assertSafeSql } from '@/lib/database/sql-guard'
import { maskVerifiedTriggerSyntax } from './trigger-migration'
import { assertExplicitForeignKeyDelete } from './foreign-key-contract'
import { parseForeignKeyReplacements } from './foreign-key-replacement'

export const environmentSchema = z.object({
  project_ref: z.string().min(1),
  environment: z.enum(['development', 'production']),
  source: z.literal('supremo_provisioned'),
})
export type DatabaseEnvironment = z.infer<typeof environmentSchema>

export function describeEnvironment(record: unknown, linkedRef: string | null) {
  const parsed = environmentSchema.safeParse(record)
  const trusted = parsed.success && parsed.data.project_ref === linkedRef
  return {
    environment: trusted ? parsed.data.environment : 'unknown',
    projectRef: linkedRef,
    source: trusted ? parsed.data.source : null,
    automaticMigrations: trusted && parsed.data.environment === 'development',
  }
}

export function requireDevelopment(record: unknown, linkedRef: string | null, expectedRef: string): string {
  const state = describeEnvironment(record, linkedRef)
  if (!state.automaticMigrations || !state.projectRef || state.projectRef !== expectedRef) {
    throw new Error('Banco não autorizado: exige development registrado pelo Supremo e ref correspondente. Produção e ambiente desconhecido não recebem alterações automáticas.')
  }
  return state.projectRef
}

export const databaseRequestSchema = z.object({
  deviceSecret: z.string().min(10).max(256),
  projectId: z.string().uuid(),
  operation: z.enum(['status', 'migrate', 'anonymous-auth']),
  expectedRef: z.string().regex(/^[a-z0-9_-]+$/).max(64).optional(),
  migrations: z.array(z.object({
    path: z.string().regex(/^supabase\/migrations\/\d{14}_[a-zA-Z0-9_-]+\.sql$/),
    content: z.string().min(1).max(250_000),
  }).strict()).max(100).optional(),
}).strict()

/** Only the DO keyword in an idempotent INSERT clause is exempted. Keep
 * the conflict target, source query and every other token under inspection;
 * in particular this does not exempt DO UPDATE or anonymous DO blocks.
 * Expressions, quoted targets and comments within the clause remain outside
 * this deliberately narrow grammar and fail closed.
 */
function maskConflictDoNothing(sql: string): string {
  return sql.replace(
    /(\bon\s+conflict(?:\s*\(\s*[a-z_][a-z_0-9]*(?:\s*,\s*[a-z_][a-z_0-9]*)*\s*\))?\s+)do(?=\s+nothing\b)/gi,
    '$1  ',
  )
}

export function validateAutomaticMigration(sql: string): void {
  assertSafeSql(sql, { allowDdl: true })
  assertExplicitForeignKeyDelete(sql)
  // This grammar only authorizes a candidate. The service verifies equivalence
  // against the locked catalog inside the migration transaction before applying.
  if (parseForeignKeyReplacements(sql).length > 0) return
  // Conservador: operações destrutivas/dinâmicas seguem fora do caminho automático.
  // Examina também strings e comentários: falsos positivos falham explicitamente.
  // BEGIN de um corpo PL/pgSQL e EXECUTE FUNCTION de um gatilho verificado
  // não são transação nem SQL dinâmico. O restante do corpo continua inspecionado.
  const checked = maskConflictDoNothing(maskVerifiedTriggerSyntax(sql))
    .replace(/\bon\s+delete\s+(cascade|restrict|set\s+null|no\s+action)\b/gi, '')
    .replace(/\bfor\s+delete\b/gi, '')
  if (/\b(drop|truncate|execute|do|commit|rollback|begin|call|copy|dblink|pg_read_file|pg_write_file)\b|\bdelete\s+from\b|\bupdate\s+[\w."]+\s+set\b/i.test(checked) || /\bsupabase_migrations\b/i.test(sql)) {
    throw new Error('Migration recusada: operação destrutiva, dinâmica ou controle de transação não permitido no fluxo automático. Para excluir linhas específicas autorizadas em development, use data delete-plan e data delete-apply. SQL destrutivo arbitrário não é suportado por esse canal; salvar um arquivo para revisão não enfileira sua aplicação.')
  }
}
