/** Real local PostgreSQL proof of control-plane function leases. Creates a new
 * disposable database; never applies migrations to an app or hosted database. */
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'

const target = process.env.SUPREMO_TEST_DATABASE_URL
if (!target) throw new Error('SUPREMO_TEST_DATABASE_URL obrigatório.')
const url = new URL(target)
if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Use somente PostgreSQL local descartável.')
const psql = process.env.SUPREMO_TEST_PSQL ?? 'psql'
function execute(connection: string, sql: string): string {
  return execFileSync(psql, [connection, '-XqAt', '-v', 'ON_ERROR_STOP=1'], { input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
}
const name = `supremo_function_leases_${process.pid}_${Date.now()}`
const local = new URL(url); local.pathname = `/${name}`
const run = (sql: string): string => execute(local.toString(), sql)
const backend = (sql: string): string => run(`SET ROLE service_role; ${sql}`)
const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const claim = (token: number, owner = 1, project = 11, ref = 'lease-dev', environment = 'development'): string =>
  `SELECT claim_function_operation('${id(project)}','${id(owner)}','${ref}','${environment}','${id(token)}');`
const verify = (token: number, owner = 1, project = 11, ref = 'lease-dev', environment = 'development'): string =>
  `SELECT verify_function_operation('${id(project)}','${id(owner)}','${ref}','${environment}','${id(token)}');`
const release = (token: number): string =>
  `DELETE FROM function_operation_leases WHERE target_ref='lease-dev' AND project_id='${id(11)}' AND user_id='${id(1)}' AND claim_token='${id(token)}' RETURNING claim_token;`
execute(target, `CREATE DATABASE ${name};`)
try {
  run(`DO $$ BEGIN
    IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
  END $$;
  CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
  CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT '{}'::jsonb $$;`)
  for (const file of ['001_initial_schema.sql', '018_database_environments.sql', '027_function_operation_leases.sql'])
    run(readFileSync(new URL(`../supabase/migrations/${file}`, import.meta.url), 'utf8'))
  run(`GRANT USAGE ON SCHEMA public,auth TO anon,authenticated,service_role;
    INSERT INTO auth.users(id) VALUES('${id(1)}'),('${id(2)}');
    INSERT INTO supabase_accounts(id,user_id,org_name,org_slug,access_token_encrypted) VALUES
      ('${id(101)}','${id(1)}','Lease fixture A','lease-fixture-a','synthetic-unused'),
      ('${id(102)}','${id(2)}','Lease fixture B','lease-fixture-b','synthetic-unused');
    INSERT INTO projects(id,user_id,name,supabase_account_id,supabase_project_ref) VALUES
      ('${id(11)}','${id(1)}','Lease development fixture','${id(101)}','lease-dev'),
      ('${id(22)}','${id(2)}','Lease production fixture','${id(102)}','lease-prod');
    INSERT INTO project_database_environments(project_id,project_ref,environment,source) VALUES
      ('${id(11)}','lease-dev','development','supremo_provisioned'),('${id(22)}','lease-prod','production','supremo_provisioned');`)
  for (const sql of [claim(201, 2), claim(201, 1, 22), claim(201, 1, 11, 'foreign-ref'), claim(201, 1, 11, 'lease-dev', 'production'), claim(201, 2, 22, 'lease-prod', 'development')])
    assert.equal(backend(sql), '', 'Foreign owner/ref/environment cannot claim')

  // Hold a real transaction while a second connection attempts the same ref.
  const holder = spawn(psql, [local.toString(), '-XqAt', '-v', 'ON_ERROR_STOP=1'], { stdio: ['pipe', 'pipe', 'pipe'] })
  const finished = new Promise<void>((resolve, reject) => {
    let stderr = ''; holder.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    holder.once('error', reject); holder.once('close', code => code === 0 ? resolve() : reject(new Error(stderr)))
  })
  const locked = new Promise<void>((resolve, reject) => {
    holder.stdout.on('data', (chunk: Buffer) => { if (chunk.toString().includes('LEASE_LOCKED')) resolve() })
    holder.once('error', reject); holder.once('close', code => { if (code !== 0) reject(new Error('Lease fixture failed before locking')) })
  })
  holder.stdin.end(`BEGIN; SET LOCAL ROLE service_role; ${claim(201)} SELECT 'LEASE_LOCKED'; SELECT pg_sleep(0.4); COMMIT;`)
  await locked
  assert.equal(backend(claim(202)), '', 'Concurrent second claim waits and then refuses active lease')
  await finished
  assert.equal(backend(verify(201)), 't'); assert.equal(backend(verify(202)), 'f')
  assert.equal(backend(release(202)), '', 'Wrong-token release is harmless')
  assert.equal(backend(`SELECT count(*) FROM function_operation_leases;`), '1')

  // Lease guards existing authority too: relink, reclassification, account
  // reassignment/removal and owner change invalidate a previously issued token.
  for (const [change, restore] of [
    [`UPDATE projects SET supabase_project_ref='other' WHERE id='${id(11)}';`, `UPDATE projects SET supabase_project_ref='lease-dev' WHERE id='${id(11)}';`],
    [`UPDATE project_database_environments SET environment='production' WHERE project_id='${id(11)}';`, `UPDATE project_database_environments SET environment='development' WHERE project_id='${id(11)}';`],
    [`UPDATE projects SET user_id='${id(2)}' WHERE id='${id(11)}';`, `UPDATE projects SET user_id='${id(1)}' WHERE id='${id(11)}';`],
    [`UPDATE projects SET supabase_account_id='${id(102)}' WHERE id='${id(11)}';`, `UPDATE projects SET supabase_account_id='${id(101)}' WHERE id='${id(11)}';`],
    [`UPDATE projects SET supabase_account_id=NULL WHERE id='${id(11)}';`, `UPDATE projects SET supabase_account_id='${id(101)}' WHERE id='${id(11)}';`],
  ]) { run(change!); assert.equal(backend(verify(201)), 'f'); run(restore!); assert.equal(backend(verify(201)), 't') }
  run(`UPDATE function_operation_leases SET lease_expires_at=clock_timestamp()+interval '44 seconds' WHERE target_ref='lease-dev';`)
  assert.equal(backend(verify(201)), 'f', 'Provider dispatch margin is enforced by PostgreSQL time')
  assert.equal(backend(claim(202)), '', 'Margin does not permit reclaim before expiry')
  run(`UPDATE function_operation_leases SET lease_expires_at=clock_timestamp()-interval '1 second',updated_at='2000-01-01' WHERE target_ref='lease-dev';`)
  assert.ok(backend(claim(202))); assert.equal(backend(verify(202)), 't'); assert.equal(backend(verify(201)), 'f')
  assert.equal(backend(release(201)), '', 'Old worker cannot release replacement token')
  assert.equal(backend(`SELECT claim_token FROM function_operation_leases WHERE target_ref='lease-dev';`), id(202))
  assert.equal(backend(release(202)), id(202))
  assert.ok(backend(claim(203, 2, 22, 'lease-prod', 'production')), 'Explicit trusted production is supported')

  for (const role of ['anon', 'authenticated']) for (const sql of [claim(205), verify(203, 2, 22, 'lease-prod', 'production'),
    'SELECT * FROM function_operation_leases;', 'DELETE FROM function_operation_leases;',
    `UPDATE function_operation_leases SET claim_token='${id(205)}';`, 'TRUNCATE function_operation_leases;'])
    assert.throws(() => run(`SET ROLE ${role}; ${sql}`), /permission denied/)
  assert.equal(run('BEGIN; GRANT SELECT ON function_operation_leases TO authenticated; SET LOCAL ROLE authenticated; SELECT count(*) FROM function_operation_leases; ROLLBACK;'), '0', 'RLS remains a second barrier if a grant regresses')
  assert.equal(run("SELECT relrowsecurity FROM pg_class WHERE oid='function_operation_leases'::regclass;"), 't')
  assert.equal(run("SELECT count(*) FROM pg_policies WHERE tablename='function_operation_leases';"), '0')
  assert.equal(run("SELECT count(*) FROM pg_indexes WHERE tablename='function_operation_leases' AND indexname IN ('idx_function_operation_leases_user','idx_function_operation_leases_project');"), '2')
  run(`DELETE FROM projects WHERE id='${id(22)}';`)
  assert.equal(backend('SELECT count(*) FROM function_operation_leases;'), '0', 'Fixture project cascade removes only its lease')
  console.log('✓ PostgreSQL real: migration027 serializa claims concorrentes; expiração, margem de dispatch e CAS funcionam; dono/conta/ref/ambiente são revalidados; RLS e RPCs são exclusivos do servidor.')
} finally {
  execute(target, `DROP DATABASE ${name} WITH (FORCE);`)
}
