/** Creates and cleans an isolated database on localhost PostgreSQL only. No provider credentials. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  schemaInspectionSql,
  diagnosticsSql,
} from '../src/lib/database-inspection/schema'
import {
  inspectSelectSql,
  pagedSelectSql,
  readOnlyTransaction,
} from '../src/lib/database-inspection/sql'

const target = process.env.SUPREMO_TEST_DATABASE_URL
if (!target)
  throw new Error(
    'SUPREMO_TEST_DATABASE_URL obrigatório (PostgreSQL descartável vazio).',
  )
const url = new URL(target)
if (
  !['postgresql:', 'postgres:'].includes(url.protocol) ||
  !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
)
  throw new Error('Apenas PostgreSQL localhost descartável é permitido.')
const database = `supremo_inspection_${process.pid}_${Date.now()}`
const readerRole = `${database}_reader`
const execute = (connection: string, sql: string) =>
  execFileSync(
    process.env.SUPREMO_TEST_PSQL ?? 'psql',
    [connection, '-XqAt', '-v', 'ON_ERROR_STOP=1'],
    { input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
  ).trim()
const isolated = new URL(target)
isolated.pathname = '/' + database
const run = (sql: string) => execute(isolated.toString(), sql)
execute(target, `CREATE DATABASE ${database}`)
let createdRole = false
try {
  run(`CREATE ROLE ${readerRole} NOLOGIN`)
  createdRole = true
  assert.equal(
    run(
      "SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m')",
    ),
    '0',
    'O banco precisa estar vazio.',
  )
  run(`CREATE TABLE public.teams (id integer PRIMARY KEY);
CREATE TABLE public.tickets (id integer PRIMARY KEY,team_id integer REFERENCES public.teams(id),title text NOT NULL,status text DEFAULT 'open',created_at timestamptz DEFAULT now());
INSERT INTO public.teams VALUES (1);
INSERT INTO public.tickets(id,team_id,title) VALUES (1,1,'First'),(2,1,'Second'),(3,1,'Third');
CREATE INDEX tickets_status_idx ON public.tickets(status);
ALTER TABLE public.tickets ENABLE ROW LEVEL SECURITY;
CREATE POLICY inspection_reader ON public.tickets FOR SELECT TO ${readerRole} USING (true);
CREATE VIEW public.ticket_titles AS SELECT id,title FROM public.tickets;
CREATE TABLE public.integrations(id integer PRIMARY KEY,api_key text DEFAULT 'opaque-sensitive-fixture');
GRANT USAGE ON SCHEMA public TO ${readerRole};
GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${readerRole};
CREATE FUNCTION public.attempt_write() RETURNS integer LANGUAGE plpgsql SECURITY DEFINER AS $$BEGIN INSERT INTO public.tickets(id,title) VALUES(99,'Unexpected'); RETURN 99; END$$;
GRANT EXECUTE ON FUNCTION public.attempt_write() TO ${readerRole};`)

  const query = (sql: string) =>
    run(`SET ROLE ${readerRole}; ${readOnlyTransaction(sql)}`)
  const rows = JSON.parse(
    query(
      `SELECT json_agg(result) FROM (${pagedSelectSql('SELECT id,title FROM public.tickets ORDER BY id', 1, 1)}) result`,
    ),
  ) as Array<{ id: number }>
  assert.deepEqual(
    rows.map((row) => row.id),
    [2, 3],
  ) // one result + lookahead
  const schema = JSON.parse(
    query(
      `SELECT json_agg(result) FROM (${schemaInspectionSql(50, 0)}) result`,
    ),
  ) as Array<Record<string, unknown>>
  const tickets = schema.find((row) => row.name === 'tickets')!
  assert.equal(tickets.rls_enabled, true)
  assert.equal(tickets.columns_count, 5)
  assert.equal(tickets.indexes_count, 2)
  assert.equal(tickets.foreign_keys_count, 1)
  assert.equal(tickets.policies_count, 1)
  assert.equal(schema.find((row) => row.name === 'ticket_titles')!.kind, 'view')
  const integrationColumns = schema.find((row) => row.name === 'integrations')!
    .columns as Array<{ name: string; default_expression: string | null }>
  assert.equal(
    integrationColumns.find((column) => column.name === 'api_key')!
      .default_expression,
    null,
  )
  assert.ok(!JSON.stringify(schema).includes('opaque-sensitive-fixture'))
  const diagnostics = JSON.parse(
    query(`SELECT row_to_json(result) FROM (${diagnosticsSql}) result`),
  ) as Record<string, unknown>
  assert.equal(diagnostics.database_role, readerRole)
  assert.equal(diagnostics.transaction_read_only, 'on')
  assert.equal(diagnostics.statement_timeout, '8s')

  // Security-definer EXECUTE grants do not undo a read-only transaction. Exercise
  // the real database directly, independent of the application SQL guard.
  assert.throws(
    () => query('SELECT public.attempt_write()'),
    /read-only transaction/,
  )
  assert.equal(run('SELECT count(*) FROM public.tickets'), '3')
  assert.throws(
    () => inspectSelectSql('SELECT public.attempt_write()'),
    /Consulta recusada/,
  )
  assert.throws(
    () =>
      query(
        'WITH removed AS (DELETE FROM public.tickets RETURNING *) SELECT * FROM removed',
      ),
    /read-only transaction/,
  )
  for (const sql of [
    'SELECT count(*) AS total FROM public.tickets',
    "SELECT date_trunc('day',created_at),count(*) FROM public.tickets GROUP BY 1",
    "SELECT coalesce(title,'empty'),CASE WHEN status='open' THEN 1 ELSE 0 END FROM public.tickets",
    'WITH recent AS (SELECT id FROM public.tickets) SELECT id FROM recent',
  ])
    assert.doesNotThrow(() => query(pagedSelectSql(sql, 5, 0)))
  console.log(
    '✓ PostgreSQL real: schema/views/colunas/índices/FK/RLS/policies, paginação e agregação; role restrita + READ ONLY e timeout8s; SECURITY DEFINER e DELETE em CTE recusados sem modificar dados.',
  )
} finally {
  execute(target, `DROP DATABASE ${database}`)
  if (createdRole) execute(target, `DROP ROLE ${readerRole}`)
}
