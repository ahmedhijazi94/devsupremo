import { createHash } from 'node:crypto'
import { z } from 'zod'
import {
  quoteIdent as qi,
  quoteLiteral as ql,
  tableCatalogSql,
} from './catalog'
import { jobNames, type CompiledJob } from './compile'
import { jobManifestEntrySchema } from './policy'

const hash = (s: string) => createHash('sha256').update(s).digest('hex')
const lock =
  "SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('supremo:provision:migrations'));"
const begin = `BEGIN; SET LOCAL statement_timeout='30s'; SET LOCAL lock_timeout='2s'; SET LOCAL idle_in_transaction_session_timeout='35s'; SET LOCAL search_path=pg_catalog; SET LOCAL timezone='UTC'; ${lock}`
const project = (id: string) => z.string().uuid().parse(id)
const slug = (id: string) => jobManifestEntrySchema.shape.id.parse(id)
const assertSql = (condition: string, message: string) =>
  `DO $supremo_assert$ BEGIN IF NOT (${condition}) THEN RAISE EXCEPTION USING MESSAGE=${ql(message)}; END IF; END $supremo_assert$;`
export const cronCapabilitySql = `SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_extension WHERE extname='pg_cron') AS installed,pg_catalog.to_regclass('supremo_jobs.managed_jobs') IS NOT NULL AS registry,COALESCE(pg_catalog.current_setting('cron.timezone',true),'GMT') AS timezone`

const registrySafe = () =>
  assertSql(
    `EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n JOIN pg_catalog.pg_roles r ON r.oid=n.nspowner WHERE n.nspname='supremo_jobs' AND r.rolname=CURRENT_USER) AND EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace JOIN pg_catalog.pg_roles r ON r.oid=c.relowner WHERE n.nspname='supremo_jobs' AND c.relname='managed_jobs' AND c.relkind='r' AND c.relrowsecurity AND r.rolname=CURRENT_USER AND pg_catalog.obj_description(c.oid,'pg_class')='supremo.jobs.v1')`,
    'Registro de jobs não pertence ao motor autorizado.',
  )
const capabilitiesSafe = () =>
  assertSql(
    `EXISTS(SELECT 1 FROM pg_catalog.pg_extension WHERE extname='pg_cron') AND COALESCE(pg_catalog.current_setting('cron.timezone',true),'GMT') IN ('UTC','GMT','Etc/UTC')`,
    'pg_cron indisponível ou timezone diferente de UTC.',
  )
export function bootstrapJobsSql(): string {
  return `${begin}
 CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
 ${capabilitiesSafe()}
 CREATE SCHEMA IF NOT EXISTS supremo_jobs;
 ${assertSql("EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n JOIN pg_catalog.pg_roles r ON r.oid=n.nspowner WHERE n.nspname='supremo_jobs' AND r.rolname=CURRENT_USER)", 'Schema de jobs pertence a outro papel.')}
 REVOKE ALL ON SCHEMA supremo_jobs FROM PUBLIC;
 CREATE TABLE IF NOT EXISTS supremo_jobs.managed_jobs (
 project_id uuid NOT NULL, job_id text NOT NULL, job_key text NOT NULL UNIQUE, cron_id bigint NOT NULL UNIQUE,
 role_name text NOT NULL, wrapper_name text NOT NULL, table_name text NOT NULL, manifest_hash text NOT NULL, source_fingerprint text NOT NULL, command_hash text NOT NULL,
 active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(project_id,job_id));
 ALTER TABLE supremo_jobs.managed_jobs ENABLE ROW LEVEL SECURITY;
 COMMENT ON TABLE supremo_jobs.managed_jobs IS 'supremo.jobs.v1';
 REVOKE ALL ON supremo_jobs.managed_jobs FROM PUBLIC;
 ${registrySafe()} COMMIT; SELECT true AS ready;`
}
function roleSafe(role: string, key: string): string {
  return `EXISTS(SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname=${ql(role)} AND NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcanlogin AND NOT r.rolinherit AND NOT r.rolcreaterole AND NOT r.rolcreatedb AND NOT r.rolreplication AND pg_catalog.shobj_description(r.oid,'pg_authid')=${ql(key)} AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member=r.oid))`
}
function wrapperSafe(job: CompiledJob): string {
  return `EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace JOIN pg_catalog.pg_language l ON l.oid=p.prolang JOIN pg_catalog.pg_roles o ON o.oid=p.proowner WHERE n.nspname='supremo_jobs' AND p.proname=${ql(job.wrapper)} AND p.pronargs=0 AND p.prorettype='pg_catalog.int8'::regtype AND NOT p.prosecdef AND l.lanname='sql' AND o.rolname=CURRENT_USER AND pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p.prosrc,'UTF8')),'hex')=${ql(hash(job.body))} AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE'))`
}
function sourceSafe(job: CompiledJob): string {
  return `EXISTS(SELECT 1 FROM (${tableCatalogSql(job.definition.action.table)}) t WHERE t.oid=${job.table.oid} AND t.fingerprint=${ql(job.table.fingerprint)})`
}
function policySafe(job: CompiledJob): string {
  return `(SELECT count(*) FROM pg_catalog.pg_policy p WHERE p.polrelid=${job.table.oid} AND p.polpermissive AND p.polroles=ARRAY[(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=${ql(job.role)})]::oid[] AND pg_catalog.pg_get_expr(p.polqual,p.polrelid)='true' AND ((p.polname=${ql(job.policy + '_select')} AND p.polcmd='r' AND p.polwithcheck IS NULL) OR (p.polname=${ql(job.policy + '_update')} AND p.polcmd='w' AND pg_catalog.pg_get_expr(p.polwithcheck,p.polrelid)='true')))=2`
}
export function runtimeJobSql(projectId: string, job: CompiledJob): string {
  project(projectId)
  // pg_cron background workers supply the transaction. Explicit BEGIN/COMMIT
  // break that executor; a libpq Simple Query also wraps this batch atomically.
  return `${begin.replace(/^BEGIN; /, '')} LOCK TABLE ONLY public.${qi(job.table.name)} IN ROW EXCLUSIVE MODE;
 ${registrySafe()}
 ${assertSql(`EXISTS(SELECT 1 FROM supremo_jobs.managed_jobs m JOIN cron.job j ON j.jobid=m.cron_id WHERE m.project_id=${ql(projectId)}::uuid AND m.job_key=${ql(job.key)} AND m.manifest_hash=${ql(job.manifestHash)} AND m.active AND j.active AND j.jobname=m.job_key AND j.username=CURRENT_USER AND j.database=pg_catalog.current_database() AND pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(j.command,'UTF8')),'hex')=m.command_hash)`, 'Job pausado, removido ou alterado fora do manifesto.')}
 ${assertSql(roleSafe(job.role, job.key), 'Papel do job alterado ou revogado.')}
 ${assertSql(wrapperSafe(job), 'Função do job alterada.')}
 ${assertSql(sourceSafe(job), 'Estrutura da tabela mudou. Reaplique o manifesto após revisão.')}
 ${assertSql(policySafe(job), 'Políticas do job alteradas ou revogadas.')}
 SET LOCAL ROLE ${qi(job.role)};
 SELECT supremo_jobs.${qi(job.wrapper)}();`
}

// Remove privileges from the previous immutable wrapper and target before an
// update. No DROP OWNED/CASCADE: unrelated objects can never be destroyed.
function revokePreviousSql(projectId: string, id: string): string {
  return `DO $supremo_previous$ DECLARE m record; col record; BEGIN
 SELECT * INTO m FROM supremo_jobs.managed_jobs WHERE project_id=${ql(projectId)}::uuid AND job_id=${ql(id)} FOR UPDATE;
 IF FOUND THEN
 IF NOT EXISTS(SELECT 1 FROM cron.job j WHERE j.jobid=m.cron_id AND j.jobname=m.job_key AND j.username=CURRENT_USER AND j.database=pg_catalog.current_database()) THEN RAISE EXCEPTION 'Identidade cron mudou'; END IF;
 IF EXISTS(SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname=m.role_name AND pg_catalog.shobj_description(r.oid,'pg_authid')=m.job_key) THEN
 IF to_regprocedure(format('supremo_jobs.%I()',m.wrapper_name)) IS NOT NULL THEN EXECUTE format('REVOKE ALL ON FUNCTION supremo_jobs.%I() FROM %I',m.wrapper_name,m.role_name); END IF;
 IF to_regclass(format('public.%I',m.table_name)) IS NOT NULL THEN
 EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I',m.role_name||'_select',m.table_name);
 EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I',m.role_name||'_update',m.table_name);
 EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I',m.table_name,m.role_name);
 FOR col IN SELECT attname FROM pg_catalog.pg_attribute WHERE attrelid=to_regclass(format('public.%I',m.table_name)) AND attnum>0 AND NOT attisdropped LOOP
 EXECUTE format('REVOKE ALL (%I) ON TABLE public.%I FROM %I',col.attname,m.table_name,m.role_name);
 END LOOP; END IF; END IF; END IF; END $supremo_previous$;`
}
export function applyJobsSql(
  projectId: string,
  jobs: readonly CompiledJob[],
): string {
  project(projectId)
  if (
    jobs.length < 1 ||
    jobs.length > 8 ||
    new Set(jobs.map((j) => j.definition.id)).size !== jobs.length
  )
    throw new Error('Manifesto inválido.')
  const ids = jobs.map((j) => ql(slug(j.definition.id))).join(',')
  return `${begin} ${registrySafe()} ${capabilitiesSafe()}
 ${assertSql(`(SELECT count(*) FROM supremo_jobs.managed_jobs WHERE project_id=${ql(projectId)}::uuid AND job_id NOT IN (${ids}))+${jobs.length}<=8`, 'Limite de oito jobs por projeto.')}
 ${jobs
   .map((job) => {
     if (job.key !== jobNames(projectId, job.definition.id).key)
       throw new Error('Projeto do job divergente.')
     const command = runtimeJobSql(projectId, job)
     const relation = `public.${qi(job.table.name)}`
     return `LOCK TABLE ONLY ${relation} IN ROW EXCLUSIVE MODE;
 ${assertSql(sourceSafe(job), 'Estrutura mudou durante a configuração.')}
 ${assertSql(`NOT EXISTS(SELECT 1 FROM cron.job j WHERE j.jobname=${ql(job.key)} AND NOT EXISTS(SELECT 1 FROM supremo_jobs.managed_jobs m WHERE m.project_id=${ql(projectId)}::uuid AND m.job_id=${ql(job.definition.id)} AND m.cron_id=j.jobid AND j.username=CURRENT_USER AND j.database=pg_catalog.current_database()))`, 'Nome cron já utilizado fora do motor.')}
 ${revokePreviousSql(projectId, job.definition.id)}
 DO $supremo_role$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=${ql(job.role)}) THEN CREATE ROLE ${qi(job.role)} NOLOGIN NOINHERIT NOBYPASSRLS NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION; COMMENT ON ROLE ${qi(job.role)} IS ${ql(job.key)}; END IF; END $supremo_role$;
 ${assertSql(roleSafe(job.role, job.key), 'Papel de job já existe com outra autoridade.')}
 GRANT ${qi(job.role)} TO CURRENT_USER;
 GRANT USAGE ON SCHEMA public,supremo_jobs TO ${qi(job.role)};
 GRANT SELECT (${job.selectColumns.map(qi).join(',')}) ON ${relation} TO ${qi(job.role)};
 GRANT UPDATE (${job.updateColumns.map(qi).join(',')}) ON ${relation} TO ${qi(job.role)};
 CREATE POLICY ${qi(job.policy + '_select')} ON ${relation} FOR SELECT TO ${qi(job.role)} USING (true);
 CREATE POLICY ${qi(job.policy + '_update')} ON ${relation} FOR UPDATE TO ${qi(job.role)} USING (true) WITH CHECK (true);
 DO $supremo_wrapper$ BEGIN IF to_regprocedure(${ql('supremo_jobs.' + job.wrapper + '()')}) IS NULL THEN
 EXECUTE ${ql(`CREATE FUNCTION supremo_jobs.${qi(job.wrapper)}() RETURNS bigint LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog AS ${ql(job.body)}`)};
 END IF; END $supremo_wrapper$;
 REVOKE ALL ON FUNCTION supremo_jobs.${qi(job.wrapper)}() FROM PUBLIC;
 ${assertSql(wrapperSafe(job), 'Função de job já existe com outro conteúdo.')}
 GRANT EXECUTE ON FUNCTION supremo_jobs.${qi(job.wrapper)}() TO ${qi(job.role)};
 INSERT INTO supremo_jobs.managed_jobs(project_id,job_id,job_key,cron_id,role_name,wrapper_name,table_name,manifest_hash,source_fingerprint,command_hash)
 VALUES(${ql(projectId)}::uuid,${ql(job.definition.id)},${ql(job.key)},cron.schedule(${ql(job.key)},${ql(job.definition.schedule)},${ql(command)}),${ql(job.role)},${ql(job.wrapper)},${ql(job.table.name)},${ql(job.manifestHash)},${ql(job.table.fingerprint)},${ql(hash(command))})
 ON CONFLICT(project_id,job_id) DO UPDATE SET cron_id=excluded.cron_id,role_name=excluded.role_name,wrapper_name=excluded.wrapper_name,table_name=excluded.table_name,manifest_hash=excluded.manifest_hash,source_fingerprint=excluded.source_fingerprint,command_hash=excluded.command_hash,updated_at=now();
 SELECT cron.alter_job(cron_id,active:=active) FROM supremo_jobs.managed_jobs WHERE project_id=${ql(projectId)}::uuid AND job_id=${ql(job.definition.id)};`
   })
   .join('\n')} COMMIT; SELECT true AS applied,${jobs.length} AS job_count;`
}
const whereOwn = (projectId: string, id?: string) =>
  `m.project_id=${ql(project(projectId))}::uuid${id ? ` AND m.job_id=${ql(slug(id))}` : ''}`
function pagination(limit: number, offset: number): string {
  z.number().int().min(1).max(100).parse(limit)
  z.number().int().min(0).max(10000).parse(offset)
  return `LIMIT ${limit + 1} OFFSET ${offset}`
}
export function listJobsSql(
  projectId: string,
  limit: number,
  offset: number,
  id?: string,
): string {
  return `SELECT m.job_id,m.table_name,m.active,j.schedule,'UTC' AS timezone,m.created_at,m.updated_at,(j.jobid IS NOT NULL AND j.jobname=m.job_key AND j.username=CURRENT_USER AND j.database=current_database() AND pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(j.command,'UTF8')),'hex')=m.command_hash AND j.active=m.active) AS synchronized FROM supremo_jobs.managed_jobs m LEFT JOIN cron.job j ON j.jobid=m.cron_id WHERE ${whereOwn(projectId, id)} ORDER BY m.job_id ${pagination(limit, offset)}`
}
export function historyJobsSql(
  projectId: string,
  limit: number,
  offset: number,
  id?: string,
): string {
  // PostgreSQL errors can contain entire failing rows, including credentials.
  // Raw command and return_message deliberately never leave this fixed channel.
  return `SELECT m.job_id,d.runid,d.status,d.start_time,d.end_time,CASE WHEN d.status='failed' THEN 'Execução recusada ou falhou; inspecione a estrutura e permissões do projeto.' ELSE NULL END AS diagnostic FROM supremo_jobs.managed_jobs m JOIN cron.job_run_details d ON d.jobid=m.cron_id JOIN cron.job j ON j.jobid=m.cron_id AND j.jobname=m.job_key AND j.username=CURRENT_USER AND j.database=current_database() WHERE ${whereOwn(projectId, id)} ORDER BY d.runid DESC ${pagination(limit, offset)}`
}
export function mutateJobSql(
  projectId: string,
  operation: 'cron-pause' | 'cron-resume' | 'cron-remove',
  id: string,
): string {
  project(projectId)
  slug(id)
  const filter = whereOwn(projectId, id)
  const active = operation === 'cron-resume'
  return `${begin} ${registrySafe()} ${capabilitiesSafe()}
 ${assertSql(`EXISTS(SELECT 1 FROM supremo_jobs.managed_jobs m JOIN cron.job j ON j.jobid=m.cron_id WHERE ${filter} AND j.jobname=m.job_key AND j.username=CURRENT_USER AND j.database=current_database() AND pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(j.command,'UTF8')),'hex')=m.command_hash)`, 'Job ausente ou identidade alterada. Nenhum job externo foi modificado.')}
 ${operation === 'cron-remove' ? `${revokePreviousSql(projectId, id)} SELECT cron.unschedule(m.cron_id) FROM supremo_jobs.managed_jobs m WHERE ${filter}; DELETE FROM supremo_jobs.managed_jobs m WHERE ${filter};` : `SELECT cron.alter_job(m.cron_id,active:=${active ? 'true' : 'false'}) FROM supremo_jobs.managed_jobs m WHERE ${filter}; UPDATE supremo_jobs.managed_jobs m SET active=${active ? 'true' : 'false'},updated_at=now() WHERE ${filter};`}
 COMMIT; SELECT true AS applied;`
}
