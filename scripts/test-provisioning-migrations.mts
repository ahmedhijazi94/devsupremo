import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { buildInitialMigrationQuery } from '../src/lib/provisioning/provision'
const target = process.env.SUPREMO_TEST_DATABASE_URL
if (!target || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(target).hostname)) throw new Error('Use um banco local descartável.')
const run = (sql: string) => execFileSync('psql', [target, '-XAt', '-v', 'ON_ERROR_STOP=1'], { input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
// Nomes reservados só para este teste; não acessa schemas de aplicação.
const schema = `supremo_test_${process.pid}`
const version = `9900${process.pid}`
try {
  const query = buildInitialMigrationQuery(`supabase/migrations/${version}_test.sql`, `create schema ${schema}; create table ${schema}.counter (value int); insert into ${schema}.counter values (1);`)
  run(query)
  run(query)
  assert.equal(run(`select count(*) from ${schema}.counter;`), '1')
  const bad = buildInitialMigrationQuery(`supabase/migrations/${version}1_fail.sql`, `create table ${schema}.rollback (value int); select 1 / 0;`)
  assert.throws(() => run(bad))
  assert.equal(run(`select to_regclass('${schema}.rollback') is null;`), 't')
  assert.equal(run(`select count(*) from supabase_migrations.schema_migrations where version='${version}1';`), '0')
  console.log('✓ Repetição não reaplica SQL; falha desfaz DDL e não registra migration como concluída.')
} finally {
  run(`drop schema if exists ${schema} cascade; delete from supabase_migrations.schema_migrations where version in ('${version}', '${version}1');`)
}
