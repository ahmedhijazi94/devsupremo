/** Exercises migration repair and administrative INSERT against disposable PostgreSQL. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { runDatabaseOperation } from '../src/lib/database-environment/service'

const target = process.env.SUPREMO_TEST_DATABASE_URL
if (!target || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(target).hostname)) {
  throw new Error('Use PostgreSQL localhost descartável.')
}
const database = `supremo_repairs_${process.pid}_${Date.now()}`
const isolated = new URL(target)
isolated.pathname = '/' + database
const execute = (connection: string, sql: string): string => execFileSync('psql', [connection, '-XqAt', '-v', 'ON_ERROR_STOP=1'], {
  input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
}).trim()
const run = (sql: string): string => execute(isolated.toString(), sql)
const userId = '00000000-0000-4000-8000-000000000001'
execute(target, `CREATE DATABASE ${database}`)
try {
  run(`CREATE SCHEMA auth;
    CREATE TABLE auth.users (id uuid PRIMARY KEY, email_confirmed_at timestamptz);
    INSERT INTO auth.users VALUES ('${userId}', now());
    CREATE TABLE public.orgs (id uuid PRIMARY KEY, owner_id uuid REFERENCES auth.users(id));
    ALTER TABLE public.orgs ENABLE ROW LEVEL SECURITY;
    INSERT INTO public.orgs VALUES ('${userId}', '${userId}');
    CREATE TABLE public.team_invitations (id uuid PRIMARY KEY, created_by uuid REFERENCES auth.users(id));
    ALTER TABLE public.team_invitations ENABLE ROW LEVEL SECURITY;
    INSERT INTO public.team_invitations VALUES ('${userId}', '${userId}');
    CREATE TABLE public.platform_admins (user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE);
    ALTER TABLE public.platform_admins ENABLE ROW LEVEL SECURITY;
    CREATE SCHEMA supabase_migrations;
    CREATE TABLE supabase_migrations.schema_migrations (version text PRIMARY KEY, statements text[], name text);`)
  const deps = {
    verify: async () => ({ record: { project_ref: 'disposable', environment: 'development', source: 'supremo_provisioned' }, linkedRef: 'disposable' }),
    query: async (_ref: string, sql: string): Promise<unknown> => {
      if (sql === 'select version, statements from supabase_migrations.schema_migrations order by version;') {
        return JSON.parse(run("SELECT coalesce(json_agg(m), '[]'::json) FROM supabase_migrations.schema_migrations m")) as unknown
      }
      return run(sql)
    },
    configureAuth: async () => { throw new Error('Auth config not part of this test') },
  }
  const apply = (version: string, content: string) => runDatabaseOperation(deps, 'disposable', 'migrate', [
    { path: `supabase/migrations/${version}_repair.sql`, content },
  ])
  const repair = (table: string, column: string, reference = 'auth.users') =>
    `ALTER TABLE public.${table} DROP CONSTRAINT ${table}_${column}_fkey, ADD CONSTRAINT ${table}_${column}_fkey FOREIGN KEY (${column}) REFERENCES ${reference}(id) ON DELETE NO ACTION;`
  const original = run("SELECT json_agg(t) FROM (SELECT conname, contype, condeferrable, condeferred, convalidated, conrelid, confrelid, confupdtype, confdeltype, confmatchtype, conkey, confkey FROM pg_constraint WHERE conrelid IN ('public.orgs'::regclass, 'public.team_invitations'::regclass) ORDER BY conname) t")
  const sql = '/* commit; */ ' + repair('orgs', 'owner_id') + '\n' + repair('team_invitations', 'created_by')
  await apply('20260926231000', sql)
  const after = run("SELECT json_agg(t) FROM (SELECT conname, contype, condeferrable, condeferred, convalidated, conrelid, confrelid, confupdtype, confdeltype, confmatchtype, conkey, confkey FROM pg_constraint WHERE conrelid IN ('public.orgs'::regclass, 'public.team_invitations'::regclass) ORDER BY conname) t")
  assert.equal(after, original, 'A repair must preserve the foreign-key contract')
  assert.equal(run('SELECT count(*) FROM public.orgs'), '1')
  assert.equal(run('SELECT count(*) FROM public.team_invitations'), '1')
  assert.equal(run("SELECT statements[1] FROM supabase_migrations.schema_migrations WHERE version='20260926231000'"), sql)
  assert.deepEqual(await apply('20260926231000', sql), { applied: [] })

  const master = `INSERT INTO public.platform_admins (user_id) SELECT id FROM auth.users WHERE id = '${userId}'::uuid AND email_confirmed_at IS NOT NULL ON CONFLICT (user_id) DO NOTHING;`
  await apply('20260926231100', master)
  await apply('20260926231200', master)
  assert.equal(run('SELECT count(*) FROM public.platform_admins'), '1')
  assert.equal(run("SELECT relrowsecurity FROM pg_class WHERE oid='public.platform_admins'::regclass"), 't')
  assert.throws(() => run(`DELETE FROM auth.users WHERE id='${userId}'`), /foreign key constraint/)

  // Different delete behavior, deferred validation and disabled enforcement must fail closed.
  for (const [index, definition] of [
    'ON DELETE CASCADE',
    'ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED',
    'ON DELETE NO ACTION NOT VALID',
  ].entries()) {
    const table = `bad_${index}`
    run(`CREATE TABLE public.${table} (id uuid PRIMARY KEY, user_id uuid);
      ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY;
      ALTER TABLE public.${table} ADD CONSTRAINT ${table}_user_id_fkey FOREIGN KEY(user_id) REFERENCES auth.users(id) ${definition};`)
    await assert.rejects(apply(`2026092623130${index}`, repair(table, 'user_id')), /Foreign key|foreign key|equivalente|constraint/i)
    assert.equal(run(`SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version='2026092623130${index}'`), '0')
  }
  run('CREATE TABLE public.disabled (user_id uuid REFERENCES auth.users(id)); ALTER TABLE public.disabled ENABLE ROW LEVEL SECURITY; ALTER TABLE public.disabled DISABLE TRIGGER ALL;')
  await assert.rejects(apply('20260926231400', repair('disabled', 'user_id')), /Foreign key|foreign key|equivalente|constraint/i)
  run('CREATE TABLE public.others (id uuid PRIMARY KEY); ALTER TABLE public.others ENABLE ROW LEVEL SECURITY;')
  await assert.rejects(apply('20260926231500', repair('orgs', 'owner_id', 'public.others')), /Foreign key|foreign key|equivalente|constraint/i)
  // The first replacement in this transaction must roll back when the second differs.
  const oidBefore = run("SELECT oid FROM pg_constraint WHERE conrelid='public.orgs'::regclass AND conname='orgs_owner_id_fkey'")
  await assert.rejects(apply('20260926231600', repair('orgs', 'owner_id') + repair('bad_0', 'user_id')))
  assert.equal(run("SELECT oid FROM pg_constraint WHERE conrelid='public.orgs'::regclass AND conname='orgs_owner_id_fkey'"), oidBefore)
  await assert.rejects(apply('20260926231700', 'ALTER TABLE public.orgs ADD COLUMN missing_rule uuid REFERENCES auth.users(id);'), /ON DELETE/)
  assert.equal(run("SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='orgs' AND column_name='missing_rule'"), '0')
  // Another writer registers different content after history was read. A SQL
  // comment mentioning commit must not divert the final transactional check.
  const raced = { ...deps, query: async (ref: string, query: string): Promise<unknown> => {
    if (query.startsWith('begin;')) {
      run("INSERT INTO supabase_migrations.schema_migrations VALUES ('20260926231800', ARRAY['select 1;'], 'concurrent')")
    }
    return deps.query(ref, query)
  } }
  await assert.rejects(runDatabaseOperation(raced, 'disposable', 'migrate', [
    { path: 'supabase/migrations/20260926231800_repair.sql', content: sql },
  ]), /Migration content conflict/)
  assert.equal(run("SELECT statements[1] FROM supabase_migrations.schema_migrations WHERE version='20260926231800'"), 'select 1;')
  assert.equal(run("SELECT oid FROM pg_constraint WHERE conrelid='public.orgs'::regclass AND conname='orgs_owner_id_fkey'"), oidBefore)
  console.log('✓ Same-meaning FK repair, unchanged rows/history/RLS, idempotent Master insert, mismatch rollback and pre-application contract checks passed.')
} finally {
  execute(target, `DROP DATABASE ${database}`)
}
