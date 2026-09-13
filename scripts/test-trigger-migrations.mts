/** Executes the automatic migration path against a disposable localhost DB. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { runDatabaseOperation } from '../src/lib/database-environment/service'

const target = process.env.SUPREMO_TEST_DATABASE_URL
if (!target || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(target).hostname)) {
  throw new Error('Use PostgreSQL localhost descartável.')
}
const database = `supremo_trigger_${process.pid}_${Date.now()}`
const isolated = new URL(target)
isolated.pathname = '/' + database
const execute = (connection: string, sql: string): string => execFileSync('psql', [connection, '-XqAt', '-v', 'ON_ERROR_STOP=1'], {
  input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
}).trim()
const run = (sql: string): string => execute(isolated.toString(), sql)
const createdRoles: string[] = []
execute(target, `CREATE DATABASE ${database}`)
try {
  for (const role of ['authenticated', 'anon']) {
    if (run(`SELECT count(*) FROM pg_roles WHERE rolname = '${role}'`) === '0') {
      run(`CREATE ROLE ${role} NOLOGIN`)
      createdRoles.push(role)
    }
  }
  run(`
    CREATE SCHEMA auth;
    CREATE TABLE auth.users (id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
      $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    GRANT USAGE ON SCHEMA auth, public TO authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated;
    CREATE TABLE public.expenses (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
      description text, amount_cents bigint, category text, due_date date, paid boolean NOT NULL DEFAULT false
    );
    ALTER TABLE public.expenses ENABLE ROW LEVEL SECURITY;
    CREATE POLICY owner_only ON public.expenses FOR ALL TO authenticated
      USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
    CREATE SCHEMA supabase_migrations;
    CREATE TABLE supabase_migrations.schema_migrations (version text PRIMARY KEY, statements text[], name text);
    INSERT INTO auth.users VALUES ('00000000-0000-4000-8000-000000000001'), ('00000000-0000-4000-8000-000000000002');
  `)
  const migration = {
    path: 'supabase/migrations/20260913211142_expense_audit_history.sql',
    content: readFileSync(new URL('../src/lib/database-environment/__fixtures__/expense-audit.sql', import.meta.url), 'utf8'),
  }
  const deps = {
    verify: async () => ({ record: { project_ref: 'disposable', environment: 'development', source: 'supremo_provisioned' }, linkedRef: 'disposable' }),
    query: async (_ref: string, sql: string): Promise<unknown> => {
      if (sql === 'select version, statements from supabase_migrations.schema_migrations order by version;') {
        return JSON.parse(run('SELECT coalesce(json_agg(m), \'[]\'::json) FROM supabase_migrations.schema_migrations m')) as unknown
      }
      return run(sql)
    },
    configureAuth: async () => { throw new Error('Auth config not part of this test') },
  }
  assert.deepEqual(await runDatabaseOperation(deps, 'disposable', 'migrate', [migration]), { applied: [migration.path] })
  assert.deepEqual(await runDatabaseOperation(deps, 'disposable', 'migrate', [migration]), { applied: [] })
  const owner = (sql: string): string => run(`SET ROLE authenticated; SET request.jwt.claim.sub = '00000000-0000-4000-8000-000000000001'; ${sql}`)
  const other = (sql: string): string => run(`SET ROLE authenticated; SET request.jwt.claim.sub = '00000000-0000-4000-8000-000000000002'; ${sql}`)
  const id = '00000000-0000-4000-8000-000000000010'
  owner(`INSERT INTO public.expenses (id, user_id, description, amount_cents, category, due_date)
    VALUES ('${id}', auth.uid(), 'Fixture', 1000, 'Moradia', '2026-09-01');
    UPDATE public.expenses SET paid = true WHERE id = '${id}';
    UPDATE public.expenses SET paid = false WHERE id = '${id}';
    UPDATE public.expenses SET description = 'Edited' WHERE id = '${id}';`)
  assert.equal(owner("SELECT string_agg(action, ',' ORDER BY created_at) FROM public.expense_events"), 'created,marked_paid,marked_pending,updated')
  assert.equal(other('SELECT count(*) FROM public.expense_events'), '0')
  other(`UPDATE public.expenses SET paid = true WHERE id = '${id}'`)
  assert.equal(owner('SELECT count(*) FROM public.expense_events'), '4')
  assert.throws(() => owner(`INSERT INTO public.expense_events(user_id, actor_id, expense_id, action, after_data)
    VALUES (auth.uid(), auth.uid(), '${id}', 'created', '{}'::jsonb)`), /row-level security/)
  owner("UPDATE public.expense_events SET action = 'deleted'; DELETE FROM public.expense_events;")
  assert.equal(owner('SELECT count(*) FROM public.expense_events'), '4')
  owner(`DELETE FROM public.expenses WHERE id = '${id}'`)
  assert.equal(owner('SELECT count(*) FROM public.expense_events'), '5')
  assert.equal(owner("SELECT count(*) FROM public.expense_events WHERE actor_id = auth.uid() AND created_at IS NOT NULL"), '5')
  assert.equal(owner("SELECT before_data->>'paid' || ',' || (after_data->>'paid') FROM public.expense_events WHERE action = 'marked_paid'"), 'false,true')
  assert.equal(owner("SELECT count(*) FROM public.expense_events WHERE action = 'deleted' AND after_data IS NULL AND before_data->>'description' = 'Edited'"), '1')
  console.log('✓ Migration aplicada uma vez; histórico real de criação/status/edição/exclusão, isolamento e proteção contra falsificação aprovados.')
} finally {
  execute(target, `DROP DATABASE ${database}`)
  for (const role of createdRoles) execute(target, `DROP ROLE ${role}`)
}
