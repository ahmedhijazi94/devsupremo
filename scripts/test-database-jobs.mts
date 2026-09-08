/** Isolated localhost PostgreSQL proof. No hosted projects or provider tokens.
 * Default mode controls only pg_cron's I/O boundary; generated run SQL, roles,
 * RLS, locks, constraints and transactions execute in real PostgreSQL.
 * Set SUPREMO_TEST_REAL_CRON=1 with pg_cron preloaded for the extension mode. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  tableCatalogSql,
  validateJobTable,
} from '../src/lib/database-jobs/catalog'
import { compileJob } from '../src/lib/database-jobs/compile'
import { jobsManifestSchema } from '../src/lib/database-jobs/policy'
import {
  bootstrapJobsSql,
  applyJobsSql,
  runtimeJobSql,
  mutateJobSql,
  listJobsSql,
  historyJobsSql,
} from '../src/lib/database-jobs/sql'

const target = process.env.SUPREMO_TEST_DATABASE_URL
if (!target) throw new Error('SUPREMO_TEST_DATABASE_URL obrigatório.')
const url = new URL(target)
if (
  !['postgresql:', 'postgres:'].includes(url.protocol) ||
  !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
)
  throw new Error('Apenas PostgreSQL localhost descartável.')
const name =
  process.env.SUPREMO_TEST_CRON_DATABASE ??
  `supremo_jobs_${process.pid}_${Date.now()}`
if (!/^supremo_jobs_[a-z0-9_]+$/.test(name))
  throw new Error('Nome de banco de teste inválido.')
const owner = `${name}_owner`
const projectId = '8ff6cf10-940d-4c45-907d-7fe8f753a5d0'
const otherProject = 'dfc0ad93-e6f3-4306-b9c7-42186124c180'
const execute = (connection: string, sql: string): string => {
  try {
    return execFileSync(
      process.env.SUPREMO_TEST_PSQL ?? 'psql',
      [connection, '-XqAt', '-v', 'ON_ERROR_STOP=1'],
      { input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
    ).trim()
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'stderr' in error &&
      typeof error.stderr === 'string' &&
      error.stderr
    )
      throw new Error(error.stderr)
    throw error
  }
}
const isolated = new URL(target)
isolated.pathname = '/' + name
const admin = (sql: string) => execute(isolated.toString(), sql)
const ownerConnection = new URL(isolated)
ownerConnection.username = owner
ownerConnection.password = 'isolated-fixture-password'
const run = (sql: string) => execute(ownerConnection.toString(), sql)
const runJob = (sql: string) => run(`BEGIN; ${sql} COMMIT;`)
const realCron = process.env.SUPREMO_TEST_REAL_CRON === '1'
// A controlled catalog transport only. No product feature permits bypassing a
// missing extension, and generated per-run SQL is used byte-for-byte below.
const withCronFixture = (sql: string) =>
  realCron
    ? sql
    : sql
        .replace(
          'CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;',
          '',
        )
        .replaceAll(
          "EXISTS(SELECT 1 FROM pg_catalog.pg_extension WHERE extname='pg_cron')",
          'true',
        )
const asJson = (sql: string) =>
  JSON.parse(
    run(`SELECT COALESCE(json_agg(result),'[]'::json) FROM (${sql}) result`),
  ) as unknown[]
execute(
  target,
  `CREATE ROLE ${owner} LOGIN PASSWORD 'isolated-fixture-password' CREATEROLE NOSUPERUSER NOBYPASSRLS; CREATE DATABASE ${name} OWNER ${owner};`,
)
try {
  if (realCron) {
    admin(
      'GRANT pg_read_all_settings TO ' +
        owner +
        '; CREATE EXTENSION pg_cron; GRANT USAGE ON SCHEMA cron TO ' +
        owner +
        '; GRANT EXECUTE ON FUNCTION cron.alter_job(bigint,text,text,text,text,boolean) TO ' +
        owner +
        ';',
    )
  } else
    run(`CREATE SCHEMA cron;
 CREATE TABLE cron.job(jobid bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,jobname text NOT NULL,username text NOT NULL DEFAULT current_user,database text NOT NULL DEFAULT current_database(),schedule text NOT NULL,command text NOT NULL,active boolean NOT NULL DEFAULT true,UNIQUE(jobname,username)); ALTER TABLE cron.job ENABLE ROW LEVEL SECURITY;
 CREATE TABLE cron.job_run_details(runid bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,jobid bigint REFERENCES cron.job(jobid) ON DELETE CASCADE,status text,start_time timestamptz,end_time timestamptz,return_message text); ALTER TABLE cron.job_run_details ENABLE ROW LEVEL SECURITY;
 CREATE FUNCTION cron.schedule(job_name text,schedule text,command text) RETURNS bigint LANGUAGE SQL AS $$INSERT INTO cron.job(jobname,schedule,command) VALUES(job_name,schedule,command) ON CONFLICT(jobname,username) DO UPDATE SET schedule=excluded.schedule,command=excluded.command,active=true RETURNING jobid$$;
 CREATE FUNCTION cron.alter_job(job_id bigint,schedule text DEFAULT NULL,command text DEFAULT NULL,database text DEFAULT NULL,username text DEFAULT NULL,active boolean DEFAULT NULL) RETURNS void LANGUAGE SQL AS $$UPDATE cron.job SET active=COALESCE(alter_job.active,job.active) WHERE jobid=job_id$$;
 CREATE FUNCTION cron.unschedule(job_id bigint) RETURNS boolean LANGUAGE SQL AS $$DELETE FROM cron.job WHERE jobid=job_id RETURNING true$$;`)
  run(`CREATE SCHEMA auth;
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE SQL STABLE AS $$SELECT NULL::uuid$$;
 CREATE TABLE public.tickets(id integer PRIMARY KEY,owner_id uuid NOT NULL,title text,status text NOT NULL CHECK(status IN ('open','overdue','closed')),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),session_token text);
 ALTER TABLE public.tickets ENABLE ROW LEVEL SECURITY;
 CREATE FUNCTION public.set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN NEW.updated_at=now(); RETURN NEW; END;$$;
 CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.tickets FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
 INSERT INTO public.tickets VALUES(1,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Old','open',now()-interval '2 days',now(),'private-value'),(2,'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Old2','open',now()-interval '2 days',now(),'other-private'),(3,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','New','open',now(),now(),'third-private');
 CREATE INDEX tickets_status_idx ON public.tickets(status);`)
  admin(`CREATE ROLE ${name}_authenticated NOLOGIN;`)
  run(
    `CREATE POLICY owner_only ON public.tickets TO ${name}_authenticated USING (auth.uid()=owner_id);`,
  )
  const definition = jobsManifestSchema.parse({
    version: 1,
    jobs: [
      {
        id: 'overdue',
        schedule: '0 * * * *',
        timezone: 'UTC',
        action: {
          type: 'update',
          table: 'tickets',
          set: { status: 'overdue' },
          where: [
            { column: 'status', op: 'eq', value: 'open' },
            { column: 'created_at', op: 'older_than', minutes: 1440 },
          ],
          limit: 1,
        },
      },
    ],
  }).jobs[0]!
  const readTable = () => asJson(tableCatalogSql('tickets'))[0]
  const prepare = () =>
    compileJob(projectId, definition, validateJobTable(definition, readTable()))
  let compiled = prepare()
  assert.equal(
    run(
      "SELECT rolsuper::text||','||rolbypassrls::text||','||rolcreaterole::text FROM pg_roles WHERE rolname=current_user",
    ),
    'false,false,true',
  )
  run(withCronFixture(bootstrapJobsSql()))
  run(withCronFixture(applyJobsSql(projectId, [compiled])))
  assert.equal(
    (asJson(listJobsSql(projectId, 10, 0))[0] as { synchronized: boolean })
      .synchronized,
    true,
  )
  assert.equal(asJson(listJobsSql(otherProject, 10, 0)).length, 0)
  const command = run('SELECT command FROM cron.job ORDER BY jobid LIMIT 1')
  assert.equal(command, runtimeJobSql(projectId, compiled))
  runJob(command)
  assert.equal(
    run("SELECT count(*) FROM public.tickets WHERE status='overdue'"),
    '1',
  )
  assert.equal(run('SELECT status FROM public.tickets WHERE id=3'), 'open')
  assert.throws(
    () =>
      run(
        `SET ROLE "${compiled.role}"; SELECT session_token FROM public.tickets`,
      ),
    /permission denied/,
  )
  assert.throws(
    () =>
      run(
        `SET ROLE "${compiled.role}"; UPDATE public.tickets SET owner_id='cccccccc-cccc-4ccc-8ccc-cccccccccccc'`,
      ),
    /permission denied/,
  )
  assert.throws(
    () => run(`SET ROLE "${compiled.role}"; DELETE FROM public.tickets`),
    /permission denied/,
  )
  assert.equal(
    run(`SET ROLE "${compiled.role}"; SELECT count(*) FROM public.tickets`),
    '3',
  )
  run(withCronFixture(mutateJobSql(projectId, 'cron-pause', 'overdue')))
  assert.throws(() => runJob(command), /pausado/)
  run(withCronFixture(applyJobsSql(projectId, [prepare()])))
  assert.equal(
    run('SELECT active FROM cron.job'),
    'f',
    'Apply preserves paused state',
  )
  run(withCronFixture(mutateJobSql(projectId, 'cron-resume', 'overdue')))
  runJob(command)
  assert.equal(
    run("SELECT count(*) FROM public.tickets WHERE status='overdue'"),
    '2',
  )
  assert.throws(
    () =>
      run(
        withCronFixture(mutateJobSql(otherProject, 'cron-remove', 'overdue')),
      ),
    /ausente/,
  )
  // Exact command + owner identity: even an existing registered cron ID cannot
  // be used to change or delete a job that moved to a different owner/command.
  admin("UPDATE cron.job SET command='SELECT 42'")
  assert.throws(() => runJob(command), /pausado/)
  assert.throws(
    () =>
      run(withCronFixture(mutateJobSql(projectId, 'cron-remove', 'overdue'))),
    /identidade alterada/,
  )
  run(withCronFixture(applyJobsSql(projectId, [prepare()])))
  run(
    'CREATE RULE ignore_ticket_update AS ON UPDATE TO public.tickets DO INSTEAD NOTHING',
  )
  assert.throws(() => prepare(), /Job exige tabela/)
  assert.throws(() => runJob(command), /Estrutura/)
  run('DROP RULE ignore_ticket_update ON public.tickets')
  // Index drift and resolved external dependencies must fail before mutations.
  run('CREATE INDEX tickets_title_idx ON public.tickets(title)')
  assert.throws(() => runJob(command), /Estrutura/)
  assert.throws(
    () => run(withCronFixture(applyJobsSql(projectId, [compiled]))),
    /Estrutura/,
  )
  compiled = prepare()
  run(withCronFixture(applyJobsSql(projectId, [compiled])))
  run(
    `CREATE FUNCTION public.bad_index(text) RETURNS text LANGUAGE SQL IMMUTABLE AS $$SELECT $1$$; CREATE INDEX tickets_bad_idx ON public.tickets(public.bad_index(title));`,
  )
  assert.throws(() => prepare(), /código externo/)
  run('DROP INDEX public.tickets_bad_idx; DROP FUNCTION public.bad_index(text)')
  run(
    `CREATE FUNCTION public.bad_check(text) RETURNS boolean LANGUAGE SQL AS $$SELECT true$$; ALTER TABLE public.tickets ADD CONSTRAINT bad CHECK(public.bad_check(title));`,
  )
  assert.throws(() => prepare(), /código externo/)
  run(
    'ALTER TABLE public.tickets DROP CONSTRAINT bad; DROP FUNCTION public.bad_check(text)',
  )
  // Builtin set_config can change session role despite being in pg_catalog; the
  // expression allowlist is independent of the dependency namespace proof.
  run(
    `CREATE POLICY evil ON public.tickets TO PUBLIC USING (set_config('role','postgres',true) IS NOT NULL);`,
  )
  assert.throws(() => prepare(), /Consulta recusada/)
  run('DROP POLICY evil ON public.tickets')
  run(
    `CREATE FUNCTION public.bad_role_policy(integer) RETURNS boolean LANGUAGE SQL SECURITY DEFINER AS $$SELECT true$$; CREATE POLICY hidden_job_code ON public.tickets TO "${compiled.role}" USING (public.bad_role_policy(id));`,
  )
  assert.throws(() => prepare(), /código externo/)
  run(
    'DROP POLICY hidden_job_code ON public.tickets; DROP FUNCTION public.bad_role_policy(integer)',
  )
  run(
    'ALTER FUNCTION public.set_updated_at() SET search_path=public,pg_catalog',
  )
  assert.throws(() => prepare(), /search_path seguro/)
  run('ALTER FUNCTION public.set_updated_at() RESET ALL')
  compiled = prepare()
  run(withCronFixture(applyJobsSql(projectId, [compiled])))
  // Grants revoked after apply are enforced by the DB, never repaired by a run.
  run(`REVOKE UPDATE(status) ON public.tickets FROM "${compiled.role}"`)
  assert.throws(
    () => runJob(runtimeJobSql(projectId, compiled)),
    /permission denied/,
  )
  run(withCronFixture(applyJobsSql(projectId, [prepare()])))
  // Literal injection remains literal even under a nondefault session setting.
  const injected = {
    ...definition,
    id: 'literal',
    action: {
      ...definition.action,
      set: { title: "x' ; RESET ROLE; -- \\ end" },
      where: [{ column: 'id', op: 'eq' as const, value: 3 }],
    },
  }
  const inj = compileJob(
    projectId,
    injected,
    validateJobTable(injected, readTable()),
  )
  run(withCronFixture(applyJobsSql(projectId, [inj])))
  runJob(runtimeJobSql(projectId, inj))
  assert.equal(
    run('SELECT title FROM public.tickets WHERE id=3'),
    injected.action.set.title,
  )
  if (!realCron) {
    run(
      "INSERT INTO cron.job_run_details(jobid,status,start_time,end_time,return_message) SELECT jobid,'failed',now(),now(),'private-value password row' FROM cron.job LIMIT 1",
    )
    assert.ok(
      !JSON.stringify(asJson(historyJobsSql(projectId, 10, 0))).includes(
        'private-value',
      ),
    )
  }
  run(`DROP FUNCTION supremo_jobs."${inj.wrapper}"()`)
  run(withCronFixture(mutateJobSql(projectId, 'cron-remove', 'literal')))
  assert.throws(() => runJob(runtimeJobSql(projectId, inj)), /pausado/)
  assert.equal(
    run("SELECT count(*) FROM cron.job WHERE jobname LIKE '%:literal'"),
    '0',
  )
  if (realCron) {
    const scheduledDefinition = {
      ...definition,
      id: 'scheduler',
      schedule: '* * * * *',
      action: {
        ...definition.action,
        set: { title: 'Scheduled by pg_cron' },
        where: [{ column: 'id', op: 'eq' as const, value: 3 }],
      },
    }
    const scheduled = compileJob(
      projectId,
      scheduledDefinition,
      validateJobTable(scheduledDefinition, readTable()),
    )
    run(applyJobsSql(projectId, [scheduled]))
    const deadline = Date.now() + 75000
    let confirmed = false
    while (Date.now() < deadline) {
      const changed =
        run('SELECT title FROM public.tickets WHERE id=3') ===
        'Scheduled by pg_cron'
      const succeeded =
        run(
          "SELECT count(*) FROM cron.job_run_details d JOIN cron.job j ON j.jobid=d.jobid WHERE j.jobname LIKE '%:scheduler' AND d.status='succeeded'",
        ) !== '0'
      if (changed && succeeded) {
        confirmed = true
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    if (!confirmed)
      console.log(
        'Fixture scheduler diagnosis:',
        admin(
          "SELECT COALESCE(json_agg(json_build_object('status',status,'message',return_message)),'[]') FROM cron.job_run_details",
        ),
      )
    assert.ok(confirmed, 'pg_cron não confirmou execução real em 75s')
    run(mutateJobSql(projectId, 'cron-remove', 'scheduler'))
  }
  console.log(
    `✓ Jobs PostgreSQL real (${realCron ? 'pg_cron real + execução agendada confirmada' : 'fronteira cron controlada'}): owner CREATEROLE sem SUPER/BYPASS, atualização útil e limitada, RLS/colunas privadas, idempotência/pausa/retomada/remoção, owner/ref de job, hashes, índice/dependência/trigger drift, revogação, literais seguros e logs sem dados privados.`,
  )
} finally {
  const roles = admin(
    "SELECT rolname FROM pg_roles WHERE rolname LIKE 'supremo_job_%' AND shobj_description(oid,'pg_authid') LIKE 'supremo:" +
      projectId +
      ":%'",
  )
    .split('\n')
    .filter(Boolean)
  execute(target, `DROP DATABASE ${name} WITH (FORCE)`)
  for (const role of roles) execute(target, `DROP ROLE "${role}"`)
  execute(target, `DROP ROLE ${owner}; DROP ROLE ${name}_authenticated;`)
}
