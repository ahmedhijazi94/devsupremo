import { z } from 'zod'
import { quoteLiteral as ql } from './catalog'
import { assertSql, begin, registrySafe } from './sql'
import { dailySchedule, jobTimezoneSchema } from './schedule'

export const executionRegistrySafe = () => assertSql("EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace JOIN pg_catalog.pg_roles r ON r.oid=c.relowner WHERE n.nspname='supremo_jobs' AND c.relname='executions' AND c.relkind='r' AND c.relrowsecurity AND r.rolname=CURRENT_USER AND pg_catalog.obj_description(c.oid,'pg_class')='supremo.job-executions.v1')", 'Histórico de execuções não pertence ao motor.')
export function bootstrapExecutionsSql(): string {
  return `${begin} ${registrySafe()}
 ${assertSql("pg_catalog.to_regclass('supremo_jobs.executions') IS NULL OR EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace JOIN pg_catalog.pg_roles r ON r.oid=c.relowner WHERE n.nspname='supremo_jobs' AND c.relname='executions' AND c.relkind='r' AND c.relrowsecurity AND r.rolname=CURRENT_USER AND pg_catalog.obj_description(c.oid,'pg_class')='supremo.job-executions.v1')", 'Histórico preexistente não autorizado.')}
 CREATE TABLE IF NOT EXISTS supremo_jobs.executions(project_id uuid NOT NULL,job_id text NOT NULL,execution_key text NOT NULL,command_hash text NOT NULL,status text NOT NULL DEFAULT 'running',affected_rows bigint,invocation_id uuid,request_id bigint,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(project_id,job_id,execution_key),FOREIGN KEY(project_id,job_id) REFERENCES supremo_jobs.managed_jobs(project_id,job_id) ON DELETE CASCADE);
 ALTER TABLE supremo_jobs.executions ENABLE ROW LEVEL SECURITY;
 REVOKE ALL ON supremo_jobs.executions FROM PUBLIC,anon,authenticated;
 COMMENT ON TABLE supremo_jobs.executions IS 'supremo.job-executions.v1';
 ALTER TABLE supremo_jobs.managed_jobs ADD COLUMN IF NOT EXISTS timezone text NOT NULL DEFAULT 'UTC';
 ALTER TABLE supremo_jobs.managed_jobs ADD COLUMN IF NOT EXISTS requested_schedule text;
 ALTER TABLE supremo_jobs.managed_jobs ADD COLUMN IF NOT EXISTS execution_command text;
 ALTER TABLE supremo_jobs.managed_jobs ADD COLUMN IF NOT EXISTS execution_command_hash text;
 ${executionRegistrySafe()} COMMIT; SELECT true AS ready;`
}
/** Wrap only server-generated, hash-checked commands. The effect and receipt
 * commit together; HTTP work is a pg_net queue insertion, not delivery proof. */
export function executionBlock(projectId: string, jobId: string, keyExpression: string, commandExpression: string, guard = 'true'): string {
  z.string().uuid().parse(projectId); z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/).parse(jobId)
  return `DO $supremo_execution$ DECLARE requested_key text; current_job record; changed bigint; dispatched record; BEGIN
 IF ${guard} THEN
 requested_key:=${keyExpression};
 SELECT m.*,j.command,COALESCE(m.execution_command,j.command) AS runnable_command INTO STRICT current_job FROM supremo_jobs.managed_jobs m JOIN cron.job j ON j.jobid=m.cron_id WHERE m.project_id=${ql(projectId)}::uuid AND m.job_id=${ql(jobId)} AND m.active AND j.active AND j.jobname=m.job_key AND j.username=CURRENT_USER AND j.database=pg_catalog.current_database() AND pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(j.command,'UTF8')),'hex')=m.command_hash AND (m.execution_command IS NULL OR pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(m.execution_command,'UTF8')),'hex')=m.execution_command_hash) FOR UPDATE OF m;
 IF EXISTS(SELECT 1 FROM supremo_jobs.executions e WHERE e.project_id=${ql(projectId)}::uuid AND e.job_id=${ql(jobId)} AND e.execution_key=requested_key AND e.command_hash<>current_job.command_hash) THEN RAISE EXCEPTION 'Job mudou desde o pedido original'; END IF;
 INSERT INTO supremo_jobs.executions(project_id,job_id,execution_key,command_hash) VALUES(${ql(projectId)}::uuid,${ql(jobId)},requested_key,current_job.command_hash) ON CONFLICT DO NOTHING;
 IF FOUND THEN
 IF current_job.role_name='' THEN EXECUTE ${commandExpression}; ELSE EXECUTE ${commandExpression} INTO changed; END IF;
 RESET ROLE;
 UPDATE supremo_jobs.executions e SET status=CASE WHEN current_job.role_name='' THEN 'dispatched' ELSE 'completed' END,affected_rows=changed,updated_at=now() WHERE e.project_id=${ql(projectId)}::uuid AND e.job_id=${ql(jobId)} AND e.execution_key=requested_key;
 IF current_job.role_name='' THEN
 SELECT f.invocation_id,f.request_id INTO dispatched FROM supremo_jobs.function_requests f WHERE f.project_id=${ql(projectId)}::uuid AND f.job_id=${ql(jobId)} AND f.created_at>=pg_catalog.transaction_timestamp() ORDER BY f.created_at DESC LIMIT 1;
 UPDATE supremo_jobs.executions e SET invocation_id=dispatched.invocation_id,request_id=dispatched.request_id WHERE e.project_id=${ql(projectId)}::uuid AND e.job_id=${ql(jobId)} AND e.execution_key=requested_key;
 END IF; END IF; END IF; END $supremo_execution$;`
}
export function localDailyCommand(projectId: string, jobId: string, timezone: string, schedule: string, command: string): string {
  if (timezone === 'UTC') return command
  const daily = dailySchedule(schedule); jobTimezoneSchema.parse(timezone)
  if (!daily) throw new Error('Fusos locais exigem horário diário fixo.')
  const local = `pg_catalog.transaction_timestamp() AT TIME ZONE ${ql(timezone)}`
  return `${begin.replace(/^BEGIN; /, '')} ${registrySafe()} ${executionRegistrySafe()} ${executionBlock(projectId, jobId, `'local:'||pg_catalog.to_char(${local},'YYYY-MM-DD')`, ql(command), `extract(hour from ${local})=${daily.hour} AND extract(minute from ${local})=${daily.minute}`)}`
}
export function runNowSql(projectId: string, jobId: string, operationId: string): string {
  z.string().uuid().parse(operationId)
  const key = `manual:${operationId}`
  return `${begin} ${registrySafe()} ${executionRegistrySafe()}
 ${executionBlock(projectId, jobId, ql(key), 'current_job.runnable_command')}
 COMMIT; SELECT execution_key,status,affected_rows,invocation_id::text,request_id,created_at,updated_at,(status='completed') AS effect_verified FROM supremo_jobs.executions WHERE project_id=${ql(projectId)}::uuid AND job_id=${ql(jobId)} AND execution_key=${ql(key)};`
}
