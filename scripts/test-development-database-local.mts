/** PostgreSQL real e descartável: DDL/histórico, autoridade inacessível ao cliente e RLS. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { buildProjectFiles } from '../src/lib/templates/project-files'
import { buildInitialMigrationQuery } from '../src/lib/provisioning/provision'
import { runDatabaseOperation } from '../src/lib/database-environment/service'
import { describeEnvironment } from '../src/lib/database-environment/policy'
const target = process.env.SUPREMO_TEST_DATABASE_URL
if (!target || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(target).hostname)) throw new Error('Use um Postgres local descartável.')
const run = (sql: string) => execFileSync(process.env.SUPREMO_TEST_PSQL ?? 'psql', [target, '-XqAt', '-v', 'ON_ERROR_STOP=1'], { input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
run(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
create schema auth; create table auth.users (id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth, public to authenticated; grant usage on schema public to service_role;
create table public.projects (id uuid primary key);
create function public.update_updated_at() returns trigger language plpgsql as $$ begin new.updated_at=now(); return new; end $$;
${readFileSync(new URL('../supabase/migrations/018_database_environments.sql', import.meta.url), 'utf8')}
insert into public.projects values ('00000000-0000-4000-8000-000000000001');
set role service_role;
insert into public.project_database_environments(project_id,project_ref,environment,source) values ('00000000-0000-4000-8000-000000000001','local-dev','development','supremo_provisioned'); reset role;`)
for (const role of ['anon', 'authenticated']) {
  for (const sql of ["select * from public.project_database_environments", "update public.project_database_environments set environment='development'", "insert into public.project_database_environments values ('00000000-0000-4000-8000-000000000002','production','development','supremo_provisioned',now(),now())"]) {
    assert.throws(() => run(`set role ${role}; ${sql};`))
  }
}
const readRecord = () => JSON.parse(run("select row_to_json(e) from project_database_environments e;")) as unknown
assert.equal(describeEnvironment(readRecord(), 'local-dev').automaticMigrations, true)
const initial = buildProjectFiles({ projectName: 'new-project', description: '', kind: 'public' }).filter((f) => f.path.startsWith('supabase/migrations/'))
for (const file of initial) run(buildInitialMigrationQuery(file.path, file.content))
const feature = { path: 'supabase/migrations/20260905000001_private_notes.sql', content: readFileSync(new URL('./fixtures/private-notes.sql', import.meta.url), 'utf8') }
const deps = {
  verify: async () => ({ record: readRecord(), linkedRef: 'local-dev' }),
  query: async (_ref: string, sql: string): Promise<unknown> => {
    if (sql.startsWith('select version')) return JSON.parse(run('select coalesce(json_agg(m),\'[]\'::json) from supabase_migrations.schema_migrations m;')) as unknown
    run(sql); return []
  },
  configureAuth: async () => { throw new Error('Auth real é testado pelo E2E remoto; não simular sucesso aqui.') },
}
assert.deepEqual((await runDatabaseOperation(deps, 'local-dev', 'migrate', [...initial, feature])).applied, [feature.path])
assert.deepEqual((await runDatabaseOperation(deps, 'local-dev', 'migrate', [...initial, feature])).applied, [])
await assert.rejects(runDatabaseOperation(deps, 'local-dev', 'migrate', [{ ...feature, content: feature.content + '\nselect 1;' }]), /alterada/)
const invalid = { path: 'supabase/migrations/20260905000002_bad.sql', content: 'create table bad (id int); alter table bad enable row level security; select 1/0;' }
await assert.rejects(runDatabaseOperation(deps, 'local-dev', 'migrate', [invalid]))
assert.equal(run("select to_regclass('public.bad') is null;"), 't')
assert.equal(run("select count(*) from supabase_migrations.schema_migrations where version='20260905000002';"), '0')
run("insert into auth.users values ('00000000-0000-4000-8000-000000000001'),('00000000-0000-4000-8000-000000000002');")
const asUser = (id: number, sql: string) => run(`set role authenticated; select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-00000000000${id}',false); ${sql}`).split('\n').slice(1).join('\n')
asUser(1, "insert into private_notes(user_id,body) values(auth.uid(),'privado A');")
assert.equal(asUser(1, 'select count(*) from private_notes;'), '1')
assert.equal(asUser(2, 'select count(*) from private_notes;'), '0')
assert.throws(() => asUser(2, "insert into private_notes(user_id,body) values('00000000-0000-4000-8000-000000000001','forjado');"))
assert.equal(asUser(2, "with rows as (update private_notes set body='ataque' returning *) select count(*) from rows;"), '0')
assert.equal(asUser(2, 'with rows as (delete from private_notes returning *) select count(*) from rows;'), '0')
run("update project_database_environments set environment='production';")
await assert.rejects(runDatabaseOperation(deps, 'local-dev', 'migrate', [feature]), /não autorizado/)
await assert.rejects(runDatabaseOperation(deps, 'local-dev', 'anonymous-auth'), /não autorizado/)
console.log('✓ PostgreSQL real: classificação protegida, migration aplicada, retry, rollback e RLS SELECT/INSERT/UPDATE/DELETE; produção recusa ambas as operações.')
