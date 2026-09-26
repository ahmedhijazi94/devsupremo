import { createHash } from 'node:crypto'
import { z } from 'zod'
import { quoteLiteral as ql } from './catalog'
import { jobNames } from './compile'
import { scheduledFunctionNames } from './function-contract'
import { functionJobManifestEntrySchema, type FunctionJobDefinition } from './policy'
import { assertSql, begin, capabilitiesSafe, registrySafe, revokePreviousSql } from './sql'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
export function bootstrapFunctionJobsSql(): string {
  return `${begin} ${registrySafe()}
 CREATE SCHEMA IF NOT EXISTS extensions;
 CREATE SCHEMA IF NOT EXISTS vault;
 CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;
 CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
 CREATE EXTENSION IF NOT EXISTS supabase_vault WITH SCHEMA vault;
 ${assertSql("EXISTS(SELECT 1 FROM pg_catalog.pg_extension e JOIN pg_catalog.pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='pgcrypto' AND n.nspname='extensions') AND pg_catalog.to_regclass('net._http_response') IS NOT NULL AND pg_catalog.to_regclass('vault.decrypted_secrets') IS NOT NULL", 'Extensões de agendamento HTTP indisponíveis.')}
 ${assertSql("pg_catalog.to_regclass('supremo_jobs.function_requests') IS NULL OR EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace JOIN pg_catalog.pg_roles r ON r.oid=c.relowner WHERE n.nspname='supremo_jobs' AND c.relname='function_requests' AND r.rolname=CURRENT_USER AND c.relkind='r' AND c.relrowsecurity AND pg_catalog.obj_description(c.oid,'pg_class')='supremo.function-requests.v1')", 'Tabela HTTP preexistente não pertence ao motor.') }
 CREATE TABLE IF NOT EXISTS supremo_jobs.function_requests (
 project_id uuid NOT NULL,job_id text NOT NULL,invocation_id uuid NOT NULL,request_id bigint NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(project_id,job_id,invocation_id),
 FOREIGN KEY(project_id,job_id) REFERENCES supremo_jobs.managed_jobs(project_id,job_id) ON DELETE CASCADE);
 CREATE INDEX IF NOT EXISTS function_requests_job_time_idx ON supremo_jobs.function_requests(project_id,job_id,created_at DESC);
 ALTER TABLE supremo_jobs.function_requests ENABLE ROW LEVEL SECURITY;
 REVOKE ALL ON supremo_jobs.function_requests FROM PUBLIC,anon,authenticated;
 COMMENT ON TABLE supremo_jobs.function_requests IS 'supremo.function-requests.v1';
 ${functionRegistrySafe()} COMMIT; SELECT true AS ready;`
}
function functionRegistrySafe(): string {
 return assertSql("EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace JOIN pg_catalog.pg_roles r ON r.oid=c.relowner WHERE n.nspname='supremo_jobs' AND c.relname='function_requests' AND c.relrowsecurity AND c.relkind='r' AND r.rolname=CURRENT_USER AND pg_catalog.obj_description(c.oid,'pg_class')='supremo.function-requests.v1')", 'Histórico HTTP não pertence ao motor.')
}
/** Randomness is generated inside PostgreSQL. Neither the provisioning SQL nor
 * cron commands contain a secret literal; decrypted output is server-only. */
export function functionSecretSql(projectId: string, slug: string): string {
 const names = scheduledFunctionNames(projectId, slug)
 return `${begin} ${registrySafe()} ${functionRegistrySafe()}
 ${assertSql("NOT pg_catalog.has_table_privilege('anon','vault.decrypted_secrets','SELECT') AND NOT pg_catalog.has_table_privilege('authenticated','vault.decrypted_secrets','SELECT')", 'Vault permite leitura por clientes; configuração interrompida.')}
 DO $supremo_secret$ BEGIN IF NOT EXISTS(SELECT 1 FROM vault.secrets WHERE name=${ql(names.vault)}) THEN
 PERFORM vault.create_secret(pg_catalog.encode(extensions.gen_random_bytes(32),'hex'),${ql(names.vault)},'supremo.cron-signature.v1'); END IF; END $supremo_secret$;
 ${assertSql(`(SELECT count(*) FROM vault.decrypted_secrets WHERE name=${ql(names.vault)} AND description='supremo.cron-signature.v1' AND decrypted_secret ~ '^[a-f0-9]{64}$')=1`, 'Identidade do segredo cron divergente.')}
 COMMIT; SELECT decrypted_secret AS secret FROM vault.decrypted_secrets WHERE name=${ql(names.vault)} AND description='supremo.cron-signature.v1';`
}
export function runtimeFunctionJobSql(projectId: string, projectRef: string, raw: FunctionJobDefinition): string {
 const job = functionJobManifestEntrySchema.parse(raw)
 z.string().uuid().parse(projectId); z.string().regex(/^[a-z0-9_-]{1,64}(?![\s\S])/).parse(projectRef)
 const names = jobNames(projectId, job.id), secret = scheduledFunctionNames(projectId, job.action.slug)
 const url = `https://${projectRef}.supabase.co/functions/v1/${job.action.slug}`
 const manifestHash = hash(JSON.stringify(job))
 return `${begin.replace(/^BEGIN; /, '')} ${registrySafe()} ${functionRegistrySafe()} ${capabilitiesSafe()}
 ${assertSql(`EXISTS(SELECT 1 FROM supremo_jobs.managed_jobs m JOIN cron.job j ON j.jobid=m.cron_id WHERE m.project_id=${ql(projectId)}::uuid AND m.job_key=${ql(names.key)} AND m.manifest_hash=${ql(manifestHash)} AND m.active AND j.active AND j.jobname=m.job_key AND j.username=CURRENT_USER AND j.database=pg_catalog.current_database() AND pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(j.command,'UTF8')),'hex')=m.command_hash)`, 'Job pausado, removido ou alterado fora do manifesto.')}
 DO $supremo_invoke$ DECLARE secret_value text; stamp text; invocation uuid; payload jsonb; request bigint; signature text; BEGIN
 SELECT decrypted_secret INTO STRICT secret_value FROM vault.decrypted_secrets WHERE name=${ql(secret.vault)} AND description='supremo.cron-signature.v1';
 stamp:=floor(extract(epoch from pg_catalog.clock_timestamp()))::bigint::text; invocation:=pg_catalog.gen_random_uuid();
 payload:=pg_catalog.jsonb_build_object('jobId',${ql(job.id)},'invocationId',invocation::text,'data',${ql(JSON.stringify(job.action.body))}::jsonb);
 signature:=pg_catalog.encode(extensions.hmac(pg_catalog.convert_to(stamp||'.'||invocation::text||'.'||payload::text,'UTF8'),pg_catalog.convert_to(secret_value,'UTF8'),'sha256'),'hex');
 request:=net.http_post(url:=${ql(url)},headers:=pg_catalog.jsonb_build_object('Content-Type','application/json','x-supremo-cron-timestamp',stamp,'x-supremo-cron-id',invocation::text,'x-supremo-cron-signature',signature),body:=payload,timeout_milliseconds:=10000);
 INSERT INTO supremo_jobs.function_requests(project_id,job_id,invocation_id,request_id) VALUES(${ql(projectId)}::uuid,${ql(job.id)},invocation,request);
 DELETE FROM supremo_jobs.function_requests WHERE project_id=${ql(projectId)}::uuid AND job_id=${ql(job.id)} AND created_at<pg_catalog.now()-INTERVAL '7 days';
 END $supremo_invoke$;`
}
export function applyFunctionJobsSql(projectId: string, projectRef: string, jobs: readonly FunctionJobDefinition[], transaction = true): string {
 z.string().uuid().parse(projectId)
 if (!jobs.length || jobs.length>8 || new Set(jobs.map(job => job.id)).size!==jobs.length) throw new Error('Manifesto inválido.')
 const fragments = jobs.map(raw => {
 const job = functionJobManifestEntrySchema.parse(raw), names = jobNames(projectId, job.id)
 const command = runtimeFunctionJobSql(projectId, projectRef, job)
 return `${assertSql(`NOT EXISTS(SELECT 1 FROM cron.job j WHERE j.jobname=${ql(names.key)} AND NOT EXISTS(SELECT 1 FROM supremo_jobs.managed_jobs m WHERE m.project_id=${ql(projectId)}::uuid AND m.job_id=${ql(job.id)} AND m.cron_id=j.jobid AND j.username=CURRENT_USER AND j.database=pg_catalog.current_database()))`, 'Nome cron já utilizado fora do motor.')}
 ${revokePreviousSql(projectId, job.id)}
 INSERT INTO supremo_jobs.managed_jobs(project_id,job_id,job_key,cron_id,role_name,wrapper_name,table_name,manifest_hash,source_fingerprint,command_hash)
 VALUES(${ql(projectId)}::uuid,${ql(job.id)},${ql(names.key)},cron.schedule(${ql(names.key)},${ql(job.schedule)},${ql(command)}),'','',${ql(job.action.slug)},${ql(hash(JSON.stringify(job)))},${ql(hash(projectRef+':'+job.action.slug))},${ql(hash(command))})
 ON CONFLICT(project_id,job_id) DO UPDATE SET cron_id=excluded.cron_id,role_name='',wrapper_name='',table_name=excluded.table_name,manifest_hash=excluded.manifest_hash,source_fingerprint=excluded.source_fingerprint,command_hash=excluded.command_hash,updated_at=now();
 SELECT cron.alter_job(cron_id,active:=active) FROM supremo_jobs.managed_jobs WHERE project_id=${ql(projectId)}::uuid AND job_id=${ql(job.id)};`
 }).join('\n')
 return `${transaction ? begin : ''} ${registrySafe()} ${functionRegistrySafe()} ${capabilitiesSafe()}
 ${assertSql(`(SELECT count(*) FROM supremo_jobs.managed_jobs WHERE project_id=${ql(projectId)}::uuid AND job_id NOT IN (${jobs.map(job => ql(job.id)).join(',')}))+${jobs.length}<=8`, 'Limite de oito jobs por projeto.')}
 ${fragments} ${transaction ? `COMMIT; SELECT true AS applied,${jobs.length} AS job_count;` : ''}`
}
export function functionHistoryJobsSql(projectId: string, limit: number, offset: number, jobId?: string): string {
 z.string().uuid().parse(projectId); z.number().int().min(1).max(100).parse(limit); z.number().int().min(0).max(10000).parse(offset)
 if (jobId) functionJobManifestEntrySchema.shape.id.parse(jobId)
 return `SELECT m.job_id,d.runid,d.status,d.start_time,d.end_time,
 CASE WHEN d.status='failed' THEN 'Execução recusada ou falhou; inspecione a estrutura e permissões do projeto.' ELSE NULL END AS diagnostic,
 CASE WHEN m.role_name<>'' THEN NULL WHEN r.invocation_id IS NULL THEN 'not_dispatched' WHEN h.id IS NULL AND r.created_at<now()-INTERVAL '6 hours' THEN 'response_expired' WHEN h.id IS NULL THEN 'pending_response' WHEN h.timed_out OR h.error_msg IS NOT NULL THEN 'transport_failed' WHEN h.status_code BETWEEN 200 AND 299 THEN 'http_succeeded' ELSE 'http_failed' END AS http_status,
 h.status_code AS http_status_code,r.request_id,r.invocation_id::text
 FROM supremo_jobs.managed_jobs m JOIN cron.job_run_details d ON d.jobid=m.cron_id
 JOIN cron.job j ON j.jobid=m.cron_id AND j.jobname=m.job_key AND j.username=CURRENT_USER AND j.database=current_database()
 LEFT JOIN LATERAL(SELECT x.* FROM supremo_jobs.function_requests x WHERE x.project_id=m.project_id AND x.job_id=m.job_id AND x.created_at>=d.start_time AND x.created_at<=COALESCE(d.end_time,now()) ORDER BY x.created_at DESC LIMIT 1) r ON true
 LEFT JOIN net._http_response h ON h.id=r.request_id
 WHERE m.project_id=${ql(projectId)}::uuid${jobId ? ` AND m.job_id=${ql(jobId)}` : ''} ORDER BY d.runid DESC LIMIT ${limit+1} OFFSET ${offset}`
}
