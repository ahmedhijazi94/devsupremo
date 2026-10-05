import { execFile, execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest'

const execFileAsync = promisify(execFile)
describe.skipIf(!process.env.SUPREMO_MUTATION_TEST_SOCKET && !process.env.SUPREMO_TEST_DATABASE_URL)('OAuth migration on disposable PostgreSQL', () => {
  const socket = process.env.SUPREMO_MUTATION_TEST_SOCKET ?? '', database = `supremo_oauth_${randomUUID().replaceAll('-', '')}`
  const target = process.env.SUPREMO_TEST_DATABASE_URL ? new URL(process.env.SUPREMO_TEST_DATABASE_URL) : null
  const validTarget = target ? ['postgres:', 'postgresql:'].includes(target.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) && !target.search && !target.hash && target.pathname === '/postgres' : /^\/(?:private\/)?tmp\/supremo-mutations-pg\.[A-Za-z0-9]+$/.test(socket)
  const owner = '11111111-1111-4111-8111-111111111111', other = '22222222-2222-4222-8222-222222222222', project = '33333333-3333-4333-8333-333333333333', id = '44444444-4444-4444-8444-444444444444'
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', PATH: process.env.PATH, PGPASSFILE: '/dev/null', ...(target ? { PGPASSWORD: decodeURIComponent(target.password) } : {}) }
  let created = false, revision = '', policy = ''
  const args = (db = database) => {
    if (!validTarget) throw new Error('Private disposable PostgreSQL socket required')
    return ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-h', target?.hostname ?? socket, '-p', target ? target.port || '5432' : '56489', '-U', target ? decodeURIComponent(target.username || 'postgres') : 'postgres', '-d', db]
  }
  const run = (sql: string, db = database) => execFileSync(process.env.SUPREMO_TEST_PSQL ?? 'psql', args(db), { input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env }).trim()
  const claimState = (claim = id, asOwner = owner) => `SELECT public.claim_project_oauth_state('${'a'.repeat(64)}','${asOwner}','${project}','${claim}');`
  const finishState = (claim = id) => `SELECT public.finish_project_oauth_state('${id}','${owner}','${project}','${claim}','encrypted-token');`
  const claimRefresh = (claim = id, version = 1, asOwner = owner) => `SELECT public.claim_project_oauth_refresh('${id}','${asOwner}','${project}',${version},'${claim}');`
  const finishRefresh = (claim = id, version = 1) => `SELECT public.finish_project_oauth_refresh('${id}','${owner}','${project}',${version},'${claim}','rotated-encrypted-token');`
  beforeAll(() => {
    run(`CREATE DATABASE ${database}`, 'postgres'); created = true
    run(`DO $$BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role BYPASSRLS; END IF; END $$;`)
    run(`CREATE SCHEMA auth;CREATE TABLE auth.users(id uuid PRIMARY KEY);CREATE TABLE public.projects(id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE);ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT NULLIF(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      CREATE TABLE public.audit_logs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid,resource_type text,resource_id uuid,action text,metadata jsonb,ip_address text,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
      CREATE TABLE public.project_credentials(id uuid PRIMARY KEY);ALTER TABLE public.project_credentials ENABLE ROW LEVEL SECURITY;
      CREATE FUNCTION public.update_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN NEW.updated_at=now(); RETURN NEW; END$$;
      GRANT USAGE ON SCHEMA public,auth TO authenticated,anon,service_role;GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;`)
    for (const file of ['028_project_automation_policies.sql', '034_provider_connections_integrations.sql', '036_project_oauth_connections.sql']) run(readFileSync(`supabase/migrations/${file}`, 'utf8'))
  })
  afterAll(() => { if (created) run(`DROP DATABASE ${database} WITH(FORCE)`, 'postgres') })
  beforeEach(() => {
    run(`TRUNCATE public.project_oauth_states,public.project_oauth_credentials,public.integration_sessions,public.provider_connections,public.project_automation_policies,public.audit_logs,public.projects,auth.users CASCADE;INSERT INTO auth.users VALUES('${owner}'),('${other}');INSERT INTO public.projects VALUES('${project}','${owner}');`)
    revision = run(`SET ROLE service_role;SELECT public.save_project_automation_policy('${owner}','${project}','development',NULL,'{"enabled":true,"capabilities":["integrations.configure","credentials.use"],"resources":[],"deviceIds":[],"maxRows":25,"maxOperationsPerHour":10}'::jsonb);`)
    policy = run('SELECT id FROM public.project_automation_policies')
    run(`INSERT INTO public.project_oauth_states(id,user_id,project_id,environment,state_hash,config,redirect_uri,verifier_cipher,policy_id,policy_revision,expires_at) VALUES('${id}','${owner}','${project}','development','${'a'.repeat(64)}','{"providerKey":"example","connector":{"identity":{"account":"account-41"}}}','https://app.example.com/auth/provider/callback','encrypted-verifier','${policy}','${revision}',now()+interval '10 minutes');`)
  })
  it('denies direct token reads and RPC calls to browser roles and isolates owners', () => {
    expect(() => run('SET ROLE authenticated;SELECT token_cipher FROM public.project_oauth_credentials')).toThrow(/permission denied/)
    expect(() => run(`SET ROLE authenticated;${claimState()}`)).toThrow(/permission denied/)
    expect(run(`SET ROLE service_role;${claimState(id, other)}`)).toBe('')
    expect(run('SELECT status FROM public.project_oauth_states')).toBe('pending')
    expect(run("SELECT count(*) FROM pg_class WHERE relname IN ('project_oauth_states','project_oauth_credentials') AND relrowsecurity")).toBe('2')
  })
  it('consumes authorization once and commits connection, cipher and audit atomically', () => {
    expect(JSON.parse(run(`SET ROLE service_role;${claimState()}`))).toMatchObject({ status: 'exchanging', claim_token: id })
    expect(run(`SET ROLE service_role;${claimState()}`)).toBe('')
    expect(() => run(`SET ROLE service_role;${finishState(other)}`)).toThrow(/authorization changed/)
    expect(run('SELECT count(*) FROM public.provider_connections')).toBe('0')
    expect(run(`SET ROLE service_role;${finishState()}`)).toBe('t')
    expect(run("SELECT status||':'||verifier_cipher FROM public.project_oauth_states")).toBe('completed:')
    expect(run("SELECT account_ref||':'||(scope->>'oauth') FROM public.provider_connections")).toBe('account-41:true')
    expect(run("SELECT count(*) FROM public.audit_logs WHERE action='integration.oauth_connected'")).toBe('1')
    expect(() => run(`SET ROLE service_role;${finishState()}`)).toThrow(/authorization changed/)
  })
  it('refuses completion after policy revocation and expired state', () => {
    run(claimState()); run('UPDATE public.project_automation_policies SET enabled=false')
    expect(() => run(finishState())).toThrow(/authorization changed/)
    expect(run('SELECT count(*) FROM public.provider_connections')).toBe('0')
    run("UPDATE public.project_oauth_states SET status='pending',expires_at=now()-interval '1 second'")
    expect(run(claimState())).toBe('')
  })
  it('serializes refresh claims across actual concurrent processes and fences stale writers', async () => {
    run(claimState()); run(finishState())
    const claims = [randomUUID(), randomUUID()]
    const results = await Promise.all(claims.map(claim => execFileAsync(process.env.SUPREMO_TEST_PSQL ?? 'psql', [...args(), '-c', 'SET ROLE service_role', '-c', claimRefresh(claim)], { env })))
    expect(results.map(result => result.stdout.trim()).sort()).toEqual(['f', 't'])
    const winner = run('SELECT claim_token FROM public.project_oauth_credentials')
    expect(() => run(finishRefresh(claims.find(claim => claim !== winner)!))).toThrow(/revision changed/)
    expect(run(finishRefresh(winner))).toBe('t')
    expect(run('SELECT version FROM public.project_oauth_credentials')).toBe('2')
    expect(run(claimRefresh(id, 1))).toBe('f')
    expect(run(claimRefresh(id, 2, other))).toBe('f')
  })
  it('marks an expired refresh uncertain without reclaiming it and revocation blocks stale completion', () => {
    run(claimState()); run(finishState()); run(claimRefresh())
    run("UPDATE public.project_oauth_credentials SET claim_expires_at=now()-interval '1 second'")
    expect(run(claimRefresh(other))).toBe('f')
    expect(run('SELECT status FROM public.project_oauth_credentials')).toBe('uncertain')
    expect(run(claimRefresh(other))).toBe('f')
    expect(() => run(finishRefresh())).toThrow(/revision changed/)
    expect(run(`SELECT public.revoke_project_oauth_connection('${id}','${owner}','${project}')`)).toBe('t')
    expect(run("SELECT status||':'||token_cipher FROM public.project_oauth_credentials")).toBe('revoked:')
    expect(run(claimRefresh())).toBe('f')
  })
})
