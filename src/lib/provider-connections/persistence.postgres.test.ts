import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest'

describe.skipIf(!process.env.SUPREMO_MUTATION_TEST_SOCKET && !process.env.SUPREMO_TEST_DATABASE_URL)('integration persistence isolation on PostgreSQL', () => {
  const socket = process.env.SUPREMO_MUTATION_TEST_SOCKET ?? '', database = `supremo_integrations_${randomUUID().replaceAll('-', '')}`
  const owner = '11111111-1111-4111-8111-111111111111', other = '22222222-2222-4222-8222-222222222222', project = '33333333-3333-4333-8333-333333333333', connection = '44444444-4444-4444-8444-444444444444', credential = '55555555-5555-4555-8555-555555555555', operation = '66666666-6666-4666-8666-666666666666'
  let created = false
  const run = (sql: string, db = database) => {
    const target = process.env.SUPREMO_TEST_DATABASE_URL ? new URL(process.env.SUPREMO_TEST_DATABASE_URL) : null
    if (target ? !['postgres:', 'postgresql:'].includes(target.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) || target.search || target.hash || target.pathname !== '/postgres'
      : !/^\/(?:private\/)?tmp\/supremo-mutations-pg\.[A-Za-z0-9]+$/.test(socket)) throw new Error('Disposable local PostgreSQL required')
    return execFileSync(process.env.SUPREMO_TEST_PSQL ?? 'psql', ['-XqAt', '-v', 'ON_ERROR_STOP=1', '-h', target?.hostname ?? socket, '-p', target ? target.port || '5432' : '56489', '-U', target ? decodeURIComponent(target.username || 'postgres') : 'postgres', '-d', db], { input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env: { NODE_ENV: 'test', PATH: process.env.PATH, PGPASSFILE: '/dev/null', ...(target ? { PGPASSWORD: decodeURIComponent(target.password), PGPORT: target.port || '5432' } : {}) } }).trim()
  }
  beforeAll(() => {
    run(`CREATE DATABASE ${database}`, 'postgres'); created = true
    run("DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role BYPASSRLS; END IF; END $$;")
    run('CREATE SCHEMA auth;CREATE TABLE auth.users(id uuid PRIMARY KEY);CREATE TABLE public.projects(id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE);CREATE TABLE public.project_credentials(id uuid PRIMARY KEY,project_id uuid REFERENCES public.projects(id) ON DELETE CASCADE);ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;ALTER TABLE public.project_credentials ENABLE ROW LEVEL SECURITY;CREATE FUNCTION public.update_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN NEW.updated_at=now();RETURN NEW;END$$;GRANT USAGE ON SCHEMA public,auth TO service_role;GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;')
    for (const file of ['034_provider_connections_integrations.sql', '035_function_artifacts.sql', '037_integration_connection_proposals.sql', '040_backend_observability.sql']) run(readFileSync(`supabase/migrations/${file}`, 'utf8'))
  })
  afterAll(() => { if (created) run(`DROP DATABASE ${database} WITH(FORCE)`, 'postgres') })
  beforeEach(() => {
    run(`TRUNCATE public.integration_connection_proposals,public.function_artifacts,public.integration_sessions,public.provider_connections,public.project_credentials,public.projects,auth.users CASCADE; INSERT INTO auth.users VALUES('${owner}'),('${other}');INSERT INTO public.projects VALUES('${project}','${owner}');INSERT INTO public.project_credentials VALUES('${credential}','${project}');INSERT INTO public.provider_connections(id,user_id,project_id,credential_id,provider,environment,account_ref,scope) VALUES('${connection}','${owner}','${project}','${credential}','resend','development','credential','{}');INSERT INTO public.integration_sessions(id,user_id,project_id,connection_id,request_hash,receipt) VALUES('${operation}','${owner}','${project}','${connection}','${'a'.repeat(64)}','{}');`)
  })
  const claim = (user = owner, token = randomUUID()) => `SELECT public.claim_integration_session('${operation}','${user}','${project}','${token}');`
  it('denies browser reads/writes and claim execution on all private records', () => {
    for (const table of ['provider_connections', 'integration_sessions', 'function_artifacts', 'integration_connection_proposals', 'project_usage_snapshots', 'project_usage_alert_settings']) {
      expect(run(`SELECT relrowsecurity FROM pg_class WHERE oid='public.${table}'::regclass`)).toBe('t')
      expect(() => run(`SET ROLE authenticated;SELECT * FROM public.${table}`)).toThrow(/permission denied/)
      expect(() => run(`SET ROLE anon;DELETE FROM public.${table}`)).toThrow(/permission denied/)
    }
    expect(() => run(`SET ROLE authenticated;${claim()}`)).toThrow(/permission denied/)
  })
  it('only claims exact owner/project, serializes attempts and fences expired tokens', () => {
    expect(run(`SET ROLE service_role;${claim(other)}`)).toBe('f')
    const token = randomUUID()
    expect(run(`SET ROLE service_role;${claim(owner, token)}`)).toBe('t')
    expect(run(`SET ROLE service_role;${claim()}`)).toBe('f')
    run(`UPDATE public.integration_sessions SET claim_expires_at=now()-interval '1 second'`)
    expect(run(`SET ROLE service_role;${claim()}`)).toBe('t')
    expect(run(`SELECT count(*) FROM public.integration_sessions WHERE claim_token='${token}'`)).toBe('0')
  })
  it('revocation or deleted credentials prevent new dispatch and OAuth still requires a separate resolver', () => {
    run(`UPDATE public.provider_connections SET revoked_at=now()`)
    expect(run(`SET ROLE service_role;${claim()}`)).toBe('f')
    run('UPDATE public.provider_connections SET revoked_at=NULL;DELETE FROM public.project_credentials')
    expect(run(`SET ROLE service_role;${claim()}`)).toBe('f')
    run("UPDATE public.provider_connections SET scope='{\"oauth\":true}'")
    expect(run(`SET ROLE service_role;${claim()}`)).toBe('t')
  })
  it('preserves constraints and allows complete owned-project removal without orphaning receipts', () => {
    expect(() => run("UPDATE public.provider_connections SET provider='stripe-test',environment='production'")).toThrow()
    expect(() => run(`UPDATE public.integration_sessions SET request_hash='bad'`)).toThrow()
    run('DELETE FROM public.projects')
    expect(run('SELECT count(*) FROM public.integration_sessions')).toBe('0')
    expect(run('SELECT count(*) FROM public.provider_connections')).toBe('0')
  })
  it('preserves one observed sample per hour and target, without merging production or another database', () => {
    const sample = (ref: string, environment: string) => `INSERT INTO public.project_usage_snapshots(user_id,project_id,target_ref,environment,hour,observed_at,metrics) VALUES('${owner}','${project}','${ref}','${environment}','2026-10-05T10:00:00Z','2026-10-05T10:23:00Z','[{"name":"Tamanho do banco","value":null,"available":false}]') ON CONFLICT(project_id,target_ref,environment,hour) DO NOTHING;`
    run(`SET ROLE service_role;${sample('one', 'development')}${sample('one', 'development')}${sample('one', 'production')}${sample('two', 'development')}`)
    expect(run('SELECT count(*) FROM public.project_usage_snapshots')).toBe('3')
    expect(run("SELECT count(*) FROM public.project_usage_snapshots WHERE metrics->0->'value'='null'::jsonb")).toBe('3')
    run(`INSERT INTO public.project_usage_alert_settings(user_id,project_id,target_ref,environment,limits) VALUES('${owner}','${project}','one','development','[]')`)
    run('DELETE FROM public.projects')
    expect(run('SELECT count(*) FROM public.project_usage_snapshots')).toBe('0')
    expect(run('SELECT count(*) FROM public.project_usage_alert_settings')).toBe('0')
  })
})
