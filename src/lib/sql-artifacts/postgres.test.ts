import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

describe.skipIf(!process.env.SUPREMO_MUTATION_TEST_SOCKET && !process.env.SUPREMO_TEST_DATABASE_URL)('versioned SQL artifact ownership on disposable PostgreSQL', () => {
  const socket = process.env.SUPREMO_MUTATION_TEST_SOCKET ?? '', database = `supremo_sql_${randomUUID().replaceAll('-', '')}`
  const target = process.env.SUPREMO_TEST_DATABASE_URL ? new URL(process.env.SUPREMO_TEST_DATABASE_URL) : null
  const validTarget = target ? ['postgres:', 'postgresql:'].includes(target.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) && !target.search && !target.hash && target.pathname === '/postgres' : /^\/(?:private\/)?tmp\/supremo-mutations-pg\.[A-Za-z0-9]+$/.test(socket)
  const owner = '11111111-1111-4111-8111-111111111111', other = '22222222-2222-4222-8222-222222222222', project = '33333333-3333-4333-8333-333333333333', device = '44444444-4444-4444-8444-444444444444', otherDevice = '55555555-5555-4555-8555-555555555555'
  let created = false
  const run = (sql: string, db = database): string => {
    if (!validTarget) throw new Error('Disposable local PostgreSQL socket required')
    return execFileSync(process.env.SUPREMO_TEST_PSQL ?? 'psql', ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-h', target?.hostname ?? socket, '-p', target ? target.port || '5432' : '56489', '-U', target ? decodeURIComponent(target.username || 'postgres') : 'postgres', '-d', db], {
      input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env: { NODE_ENV: 'test', PATH: process.env.PATH, PGPASSFILE: '/dev/null', ...(target ? { PGPASSWORD: decodeURIComponent(target.password) } : {}) },
    }).trim()
  }
  const prepare = (id: string) => `SELECT row_to_json(r) FROM public.prepare_sql_artifact('${id}','${owner}','${project}','example',NULL,'select 1;',encode(sha256(convert_to('select 1;','UTF8')),'hex')) r;`
  const claim = (id = device, session = randomUUID()) => `SELECT row_to_json(r) FROM public.claim_sql_artifact('${owner}','${project}','${id}','${session}') r;`
  beforeAll(() => {
    run(`CREATE DATABASE ${database}`, 'postgres'); created = true
    run(`DO $$BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role BYPASSRLS; END IF; END $$;
      CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
      CREATE TABLE public.projects(id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE);
      CREATE TABLE public.checkpoint_devices(id uuid PRIMARY KEY,owner_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,revoked_at timestamptz);
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT NULLIF(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      GRANT USAGE ON SCHEMA public,auth TO authenticated,anon,service_role; GRANT SELECT ON public.projects TO authenticated;
      INSERT INTO auth.users VALUES('${owner}'),('${other}'); INSERT INTO projects VALUES('${project}','${owner}'); INSERT INTO checkpoint_devices VALUES('${device}','${owner}',NULL),('${otherDevice}','${other}',NULL);`)
    run(readFileSync('supabase/migrations/038_sql_artifacts.sql', 'utf8'))
  })
  afterAll(() => { if (created) run(`DROP DATABASE ${database}`, 'postgres') })
  it('allocates distinct ordered migration versions and checks the content digest in PostgreSQL', () => {
    const first = JSON.parse(run(prepare(randomUUID()))) as { path: string }, next = JSON.parse(run(prepare(randomUUID()))) as { path: string }
    expect(first.path).toMatch(/^supabase\/migrations\/\d{14}_[a-f0-9]{32}\.sql$/)
    expect(next.path > first.path).toBe(true)
    expect(() => run(prepare(randomUUID()).replace("encode(sha256(convert_to('select 1;','UTF8')),'hex')", `'${'a'.repeat(64)}'`))).toThrow()
  })
  it('enforces owner-only reads, no direct mutation and service-only claims', () => {
    expect(run(`SET ROLE authenticated;SET request.jwt.claim.sub='${other}';SELECT count(*) FROM public.project_sql_artifacts;`)).toBe('0')
    expect(Number(run(`SET ROLE authenticated;SET request.jwt.claim.sub='${owner}';SELECT count(*) FROM public.project_sql_artifacts;`))).toBe(2)
    expect(() => run(`SET ROLE authenticated;DELETE FROM public.project_sql_artifacts;`)).toThrow()
    expect(() => run(`SET ROLE authenticated;${claim()}`)).toThrow()
    expect(() => run(claim(otherDevice))).toThrow()
  })
  it('fences claims across sessions and preserves the previous materialized state on takeover', () => {
    const session = randomUUID(), first = JSON.parse(run(claim(device, session))) as { id: string; claim_token: string }
    const same = JSON.parse(run(claim(device, session))) as { id: string; claim_token: string }
    expect(same).toMatchObject({ id: first.id, claim_token: first.claim_token })
    run(`UPDATE project_sql_artifacts SET state='materialized',lease_expires_at=now()-interval '1 second' WHERE id='${first.id}';`)
    const resumed = JSON.parse(run(claim())) as { id: string; claim_token: string; state: string }
    expect(resumed.id).toBe(first.id); expect(resumed.claim_token).not.toBe(first.claim_token); expect(resumed.state).toBe('materialized')
    expect(run(`UPDATE project_sql_artifacts SET state='applied' WHERE id='${first.id}' AND claim_token='${first.claim_token}' RETURNING id;`)).toBe('')
  })
  it('rejects a revoked device before claiming prepared artifacts', () => {
    run(`UPDATE checkpoint_devices SET revoked_at=now() WHERE id='${device}';`)
    expect(() => run(claim())).toThrow()
  })
})
