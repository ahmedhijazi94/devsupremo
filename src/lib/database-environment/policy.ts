import { z } from 'zod'
import { assertSafeSql } from '@/lib/database/sql-guard'

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

export function validateAutomaticMigration(sql: string): void {
  assertSafeSql(sql, { allowDdl: true })
  // Conservador: operações destrutivas/dinâmicas seguem fora do caminho automático.
  // Examina também strings e comentários: falsos positivos falham explicitamente.
  // EXECUTE FUNCTION do trigger de timestamp do scaffold não é SQL dinâmico.
  // A exceção é só esta chamada sem argumentos; EXECUTE arbitrário segue recusado.
  const checked = sql
    .replace(/\bon\s+delete\s+(cascade|restrict|set\s+null|no\s+action)\b/gi, '')
    .replace(/\bfor\s+delete\b/gi, '')
    .replace(/\bexecute\s+function\s+public\.set_updated_at\s*\(\s*\)/gi, '')
  if (/\b(drop|truncate|execute|do|commit|rollback|begin|call|copy|dblink|pg_read_file|pg_write_file)\b|\bdelete\s+from\b|\bupdate\s+[\w."]+\s+set\b/i.test(checked) || /\bsupabase_migrations\b/i.test(sql)) {
    throw new Error('Migration exige revisão: operação destrutiva, dinâmica ou controle de transação não permitido no fluxo automático.')
  }
}
