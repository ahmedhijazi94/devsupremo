import { execFileSync } from 'node:child_process'
import { randomUUID, createHash } from 'node:crypto'
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest'
import { bootstrapJobsSql } from './sql'
import { bootstrapExecutionsSql, localDailyCommand, runNowSql } from './execution-sql'
import { quoteLiteral as ql } from './catalog'

describe.skipIf(!process.env.SUPREMO_MUTATION_TEST_SOCKET && !process.env.SUPREMO_TEST_DATABASE_URL)('transactional job execution on disposable PostgreSQL', () => {
  const socket = process.env.SUPREMO_MUTATION_TEST_SOCKET ?? '', database = `supremo_jobs_${randomUUID().replaceAll('-', '')}`
  const project = '11111111-1111-4111-8111-111111111111', operation = '22222222-2222-4222-8222-222222222222'
  let created = false
  const hash = (value: string) => createHash('sha256').update(value).digest('hex')
  const run = (sql: string, db = database) => {
    const target = process.env.SUPREMO_TEST_DATABASE_URL ? new URL(process.env.SUPREMO_TEST_DATABASE_URL) : null
    if (target ? !['postgres:', 'postgresql:'].includes(target.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) || target.search || target.hash || target.pathname !== '/postgres'
      : !/^\/(?:private\/)?tmp\/supremo-mutations-pg\.[A-Za-z0-9]+$/.test(socket)) throw new Error('Disposable local PostgreSQL required')
    return execFileSync(process.env.SUPREMO_TEST_PSQL ?? 'psql', ['-XqAt', '-v', 'ON_ERROR_STOP=1', '-h', target?.hostname ?? socket, '-p', target ? target.port || '5432' : '56489', '-U', target ? decodeURIComponent(target.username || 'postgres') : 'postgres', '-d', db], { input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env: { NODE_ENV: 'test', PATH: process.env.PATH, PGPASSFILE: '/dev/null', ...(target ? { PGPASSWORD: decodeURIComponent(target.password), PGPORT: target.port || '5432' } : {}) } }).trim()
  }
  beforeAll(() => {
    run(`CREATE DATABASE ${database}`, 'postgres'); created = true
    run("DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF; END $$;")
    run(bootstrapJobsSql().replace('CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;', '').replaceAll("EXISTS(SELECT 1 FROM pg_catalog.pg_extension WHERE extname='pg_cron')", 'true'))
    run(bootstrapExecutionsSql())
    run('CREATE SCHEMA cron; CREATE TABLE cron.job(jobid bigint PRIMARY KEY,jobname text,username text,database text,command text,active boolean); ALTER TABLE cron.job ENABLE ROW LEVEL SECURITY; CREATE TABLE public.counter(value bigint); ALTER TABLE public.counter ENABLE ROW LEVEL SECURITY; INSERT INTO public.counter VALUES(0);')
  })
  afterAll(() => { if (created) run(`DROP DATABASE ${database} WITH(FORCE)`, 'postgres') })
  beforeEach(() => run('TRUNCATE supremo_jobs.executions,supremo_jobs.managed_jobs,cron.job; UPDATE public.counter SET value=0;'))
  const inner = 'UPDATE public.counter SET value=value+1; SELECT value FROM public.counter;'
  const install = (command = inner, timezone = 'UTC') => run(`INSERT INTO cron.job VALUES(1,'managed',current_user,current_database(),${ql(command)},true); INSERT INTO supremo_jobs.managed_jobs(project_id,job_id,job_key,cron_id,role_name,wrapper_name,table_name,manifest_hash,source_fingerprint,command_hash,timezone,execution_command,execution_command_hash) VALUES('${project}','daily','managed',1,'fixture','','counter','fixture','fixture','${hash(command)}',${ql(timezone)},${ql(inner)},'${hash(inner)}');`)
  it('commits effect and receipt once and refuses a changed command for the same request', () => {
    install()
    expect(run(runNowSql(project, 'daily', operation))).toContain('manual:')
    run(runNowSql(project, 'daily', operation))
    expect(run('SELECT value FROM public.counter')).toBe('1')
    expect(run('SELECT affected_rows FROM supremo_jobs.executions')).toBe('1')
    run(`UPDATE cron.job SET command='SELECT 4'; UPDATE supremo_jobs.managed_jobs SET command_hash='${hash('SELECT 4')}';`)
    expect(() => run(runNowSql(project, 'daily', operation))).toThrow()
    expect(run('SELECT value FROM public.counter')).toBe('1')
  })
  it('rolls back an effect when its transaction fails and refuses changed hash or paused jobs', () => {
    install()
    run("UPDATE supremo_jobs.managed_jobs SET execution_command='UPDATE public.counter SET value=99; SELECT 1/0;',execution_command_hash=encode(sha256(convert_to('UPDATE public.counter SET value=99; SELECT 1/0;','UTF8')),'hex')")
    expect(() => run(runNowSql(project, 'daily', operation))).toThrow()
    expect(run('SELECT value FROM public.counter')).toBe('0')
    expect(run('SELECT count(*) FROM supremo_jobs.executions')).toBe('0')
    run("UPDATE cron.job SET command='untrusted'")
    expect(() => run(runNowSql(project, 'daily', operation))).toThrow()
  })
  it('deduplicates local daily dispatch and can run the same local job immediately once', () => {
    const command = localDailyCommand(project, 'daily', 'America/New_York', '0 9 * * *', inner)
      .replace(/extract\(hour from [\s\S]+?\)=9 AND extract\(minute from [\s\S]+?\)=0/, 'true')
    install(command, 'America/New_York')
    run(`BEGIN; ${command} COMMIT;`); run(`BEGIN; ${command} COMMIT;`)
    expect(run('SELECT value FROM public.counter')).toBe('1')
    run(runNowSql(project, 'daily', operation)); run(runNowSql(project, 'daily', operation))
    expect(run('SELECT value FROM public.counter')).toBe('2')
  })
  it('rejects browser access to execution receipts and honors project/job identity', () => {
    install()
    expect(() => run('SET ROLE authenticated;SELECT * FROM supremo_jobs.executions')).toThrow()
    expect(() => run(runNowSql('33333333-3333-4333-8333-333333333333', 'daily', operation))).toThrow()
  })
})
