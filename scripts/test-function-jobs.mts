/** Disposable localhost PostgreSQL proof. Real transactions, RLS, ownership,
 * pgcrypto HMAC and generated SQL; only pg_cron/pg_net/Vault I/O are fixtures.
 * Never accepts a remote database or calls a deployed function. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { bootstrapJobsSql, mutateJobSql, listJobsSql } from '../src/lib/database-jobs/sql'
import { bootstrapFunctionJobsSql, functionSecretSql, applyFunctionJobsSql, runtimeFunctionJobSql, functionHistoryJobsSql } from '../src/lib/database-jobs/function-sql'
import { functionJobManifestEntrySchema } from '../src/lib/database-jobs/policy'

const target = process.env.SUPREMO_TEST_DATABASE_URL
if (!target) throw new Error('SUPREMO_TEST_DATABASE_URL obrigatório.')
const url = new URL(target)
if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost','127.0.0.1','[::1]'].includes(url.hostname)) throw new Error('Somente localhost descartável.')
const name = `supremo_function_jobs_${process.pid}_${Date.now()}`
const owner = `${name}_owner`
const project = '00000000-0000-4000-8000-000000000001'
const otherProject = '00000000-0000-4000-8000-000000000002'
function execute(connection: string, sql: string): string {
  try { return execFileSync('psql',[connection,'-XqAt','-v','ON_ERROR_STOP=1'],{input:sql,encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim() }
  catch (error) { if (error && typeof error==='object' && 'stderr' in error && typeof error.stderr==='string') throw new Error(error.stderr); throw error }
}
const local = new URL(target);local.pathname='/'+name
const own = new URL(local);own.username=owner;own.password='isolated-password'
const admin=(sql:string)=>execute(local.toString(),sql)
const run=(sql:string)=>execute(own.toString(),sql)
const fixture=(sql:string)=>sql.replace('CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;','').replaceAll("EXISTS(SELECT 1 FROM pg_catalog.pg_extension WHERE extname='pg_cron')",'true').replace('CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;','').replace('CREATE EXTENSION IF NOT EXISTS supabase_vault WITH SCHEMA vault;','')
const json=(sql:string)=>JSON.parse(run(`SELECT COALESCE(json_agg(x),'[]'::json) FROM (${sql}) x`)) as Record<string,unknown>[]
execute(target,`CREATE ROLE ${owner} LOGIN PASSWORD 'isolated-password' CREATEROLE NOSUPERUSER NOBYPASSRLS;CREATE DATABASE ${name} OWNER ${owner};`)
try {
  admin("DO $$BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN;END IF;IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN;END IF;END$$;")
  run(`CREATE SCHEMA cron;
 CREATE TABLE cron.job(jobid bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,jobname text NOT NULL UNIQUE,username text NOT NULL DEFAULT current_user,database text NOT NULL DEFAULT current_database(),schedule text NOT NULL,command text NOT NULL,active boolean NOT NULL DEFAULT true);ALTER TABLE cron.job ENABLE ROW LEVEL SECURITY;
 CREATE TABLE cron.job_run_details(runid bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,jobid bigint REFERENCES cron.job(jobid) ON DELETE CASCADE,status text,start_time timestamptz,end_time timestamptz);ALTER TABLE cron.job_run_details ENABLE ROW LEVEL SECURITY;
 CREATE FUNCTION cron.schedule(job_name text,schedule text,command text) RETURNS bigint LANGUAGE sql AS $$INSERT INTO cron.job(jobname,schedule,command) VALUES(job_name,schedule,command) ON CONFLICT(jobname) DO UPDATE SET schedule=excluded.schedule,command=excluded.command,active=true RETURNING jobid$$;
 CREATE FUNCTION cron.alter_job(job_id bigint,active boolean) RETURNS void LANGUAGE sql AS $$UPDATE cron.job SET active=alter_job.active WHERE jobid=job_id$$;
 CREATE FUNCTION cron.unschedule(job_id bigint) RETURNS boolean LANGUAGE sql AS $$DELETE FROM cron.job WHERE jobid=job_id RETURNING true$$;
 CREATE SCHEMA extensions;CREATE EXTENSION pgcrypto WITH SCHEMA extensions;
 CREATE SCHEMA vault;CREATE TABLE vault.secrets(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),name text UNIQUE NOT NULL,description text NOT NULL,secret text NOT NULL);ALTER TABLE vault.secrets ENABLE ROW LEVEL SECURITY;
 CREATE VIEW vault.decrypted_secrets AS SELECT id,name,description,secret AS decrypted_secret FROM vault.secrets;
 CREATE FUNCTION vault.create_secret(value text,name text,description text) RETURNS uuid LANGUAGE sql AS $$INSERT INTO vault.secrets(secret,name,description) VALUES(value,name,description) RETURNING id$$;
 CREATE SCHEMA net;CREATE TABLE net.captured_requests(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,url text,headers jsonb,body jsonb,body_text text);ALTER TABLE net.captured_requests ENABLE ROW LEVEL SECURITY;
 CREATE TABLE net._http_response(id bigint PRIMARY KEY,status_code int,timed_out boolean,error_msg text);ALTER TABLE net._http_response ENABLE ROW LEVEL SECURITY;
 CREATE FUNCTION net.http_post(url text,headers jsonb,body jsonb,timeout_milliseconds int) RETURNS bigint LANGUAGE sql AS $$INSERT INTO net.captured_requests(url,headers,body,body_text) VALUES(url,headers,body,body::text) RETURNING id$$;`)
  run(fixture(bootstrapJobsSql()))
  run(fixture(bootstrapFunctionJobsSql()))
  const secret=run(functionSecretSql(project,'daily-report'))
  assert.match(secret,/^[a-f0-9]{64}$/)
  assert.equal(run(functionSecretSql(project,'daily-report')),secret,'Signer does not rotate on reapply')
  const definition=functionJobManifestEntrySchema.parse({id:'daily-report',schedule:'0 12 * * *',timezone:'UTC',action:{type:'function',slug:'daily-report',body:{digest:true,label:"quoted '; -- text"}}})
  run(fixture(applyFunctionJobsSql(project,'project-fixture',[definition])))
  run(fixture(applyFunctionJobsSql(project,'project-fixture',[definition])))
  assert.equal(run('SELECT count(*) FROM cron.job'),'1')
  assert.equal(json(listJobsSql(project,10,0))[0]?.synchronized,true)
  assert.equal(json(listJobsSql(otherProject,10,0)).length,0)
  const command=runtimeFunctionJobSql(project,'project-fixture',definition)
  assert.equal(run('SELECT command FROM cron.job LIMIT 1'),command)
  assert.ok(!command.includes(secret))
  run("INSERT INTO cron.job_run_details(jobid,status,start_time) SELECT jobid,'succeeded',clock_timestamp() FROM cron.job")
  run(`BEGIN;${fixture(command)}COMMIT;UPDATE cron.job_run_details SET end_time=clock_timestamp();`)
  const captured=json('SELECT * FROM net.captured_requests')[0]!
  assert.equal(captured.url,'https://project-fixture.supabase.co/functions/v1/daily-report')
  const headers=captured.headers as Record<string,string>
  assert.equal(headers['x-supremo-cron-signature'],createHmac('sha256',secret).update(`${headers['x-supremo-cron-timestamp']}.${headers['x-supremo-cron-id']}.${captured.body_text}`).digest('hex'))
  assert.equal(json(functionHistoryJobsSql(project,10,0))[0]?.http_status,'pending_response')
  run('INSERT INTO net._http_response(id,status_code,timed_out) SELECT id,500,false FROM net.captured_requests')
  assert.equal(json(functionHistoryJobsSql(project,10,0))[0]?.http_status,'http_failed')
  run('UPDATE net._http_response SET status_code=200')
  assert.equal(json(functionHistoryJobsSql(project,10,0))[0]?.http_status,'http_succeeded')
  run('UPDATE net._http_response SET timed_out=true')
  assert.equal(json(functionHistoryJobsSql(project,10,0))[0]?.http_status,'transport_failed')
  run(fixture(mutateJobSql(project,'cron-pause','daily-report')))
  assert.throws(()=>run(`BEGIN;${fixture(command)}COMMIT;`),/pausado/)
  assert.equal(run('SELECT count(*) FROM net.captured_requests'),'1')
  run(fixture(mutateJobSql(project,'cron-resume','daily-report')))
  assert.equal(json(listJobsSql(project,10,0))[0]?.active,true)
  run('UPDATE cron.job SET command=command||\' \'')
  assert.throws(()=>run(`BEGIN;${fixture(command)}COMMIT;`),/alterado/)
  run(fixture(applyFunctionJobsSql(project,'project-fixture',[definition])))
  run(fixture(mutateJobSql(project,'cron-remove','daily-report')))
  assert.equal(run('SELECT count(*) FROM cron.job'),'0')
  assert.equal(run('SELECT count(*) FROM supremo_jobs.function_requests'),'0')
  assert.throws(()=>run(`BEGIN;${fixture(command)}COMMIT;`),/removido/)
  assert.throws(()=>admin('SET ROLE anon;SELECT * FROM vault.decrypted_secrets;'),/permission denied/)
  assert.throws(()=>admin('SET ROLE authenticated;SELECT * FROM supremo_jobs.function_requests;'),/permission denied/)
  console.log('✓ Cron HTTP em PostgreSQL isolado: SQL real, HMAC real, Vault/HTTP com fronteiras controladas; escopo, idempotência de configuração, pausa, retomada, remoção, adulteração e status HTTP confirmados. Nenhuma função hospedada foi chamada.')
} finally {
  execute(target,`DROP DATABASE IF EXISTS ${name} WITH (FORCE);DROP ROLE IF EXISTS ${owner};`)
}
