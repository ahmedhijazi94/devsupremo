import { createHash } from 'node:crypto'
import { requireDevelopment, validateAutomaticMigration } from './policy'
import { buildInitialMigrationQuery } from '@/lib/provisioning/provision'

export type Migration = { path: string; content: string }
export type MigrationHistory = { version: string; statements: string[] | null }
export interface DatabaseOperations {
  verify(): Promise<{ record: unknown; linkedRef: string | null }>
  query(ref: string, sql: string): Promise<unknown>
  configureAuth(ref: string): Promise<void>
}

export async function runDatabaseOperation(
  deps: DatabaseOperations,
  expectedRef: string,
  operation: 'migrate' | 'anonymous-auth',
  migrations: Migration[] = [],
): Promise<{ applied: string[]; anonymousAuth?: boolean }> {
  const verify = async () => {
    const state = await deps.verify()
    return requireDevelopment(state.record, state.linkedRef, expectedRef)
  }
  let ref = await verify()
  if (operation === 'anonymous-auth') {
    await deps.configureAuth(ref)
    return { applied: [], anonymousAuth: true }
  }
  const versions = migrations.map((m) => m.path.split('/').pop()!.split('_')[0]!)
  if (new Set(versions).size !== versions.length) throw new Error('Versões de migration duplicadas.')
  const history = await deps.query(ref, 'select version, statements from supabase_migrations.schema_migrations order by version;') as MigrationHistory[]
  const pending: Migration[] = []
  for (const migration of [...migrations].sort((a, b) => a.path.localeCompare(b.path))) {
    const version = migration.path.split('/').pop()!.split('_')[0]!
    const existing = history.find((row) => row.version === version)
    if (existing) {
      if (!existing.statements || existing.statements.join('\n') !== migration.content) {
        throw new Error(`Migration aplicada foi alterada: ${migration.path}. Crie outra migration.`)
      }
      continue
    }
    if (history.some((row) => row.version > version)) throw new Error(`Migration fora de ordem: ${migration.path}. Use um timestamp novo.`)
    validateAutomaticMigration(migration.content)
    pending.push(migration)
  }
  const applied: string[] = []
  for (const migration of pending) {
    ref = await verify() // Revalida a autoridade antes de CADA escrita, sem cache local.
    // O mesmo lock do provisionamento protege aplicação concorrente. Detecta
    // conteúdo divergente dentro da transação, inclusive após timeout/retry.
    const version = migration.path.split('/').pop()!.split('_')[0]!
    const digest = createHash('sha256').update(migration.content).digest('hex')
    const query = buildInitialMigrationQuery(migration.path, migration.content).replace(
      'commit;',
      `do $supremo_verify$ begin if not exists (select 1 from supabase_migrations.schema_migrations where version = '${version}' and encode(sha256(convert_to(array_to_string(statements, E'\\n'), 'UTF8')), 'hex') = '${digest}') then raise exception 'Migration content conflict'; end if; end $supremo_verify$;\ncommit;`,
    )
    await deps.query(ref, query)
    applied.push(migration.path)
  }
  return { applied }
}
