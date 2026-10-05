import { execFile, execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { promisify } from 'node:util'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const providers = ['github', 'supabase'] as const
type Provider = typeof providers[number]

describe.skipIf(!process.env.SUPREMO_MUTATION_TEST_SOCKET && !process.env.SUPREMO_TEST_DATABASE_URL)('account refresh on disposable PostgreSQL', () => {
  const socket = process.env.SUPREMO_MUTATION_TEST_SOCKET ?? ''
  const database = `supremo_account_tokens_${randomUUID().replaceAll('-', '')}`
  const target = process.env.SUPREMO_TEST_DATABASE_URL ? new URL(process.env.SUPREMO_TEST_DATABASE_URL) : null
  const validTarget = target
    ? ['postgres:', 'postgresql:'].includes(target.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) && !target.search && !target.hash && target.pathname === '/postgres'
    : /^\/(?:private\/)?tmp\/supremo-mutations-pg\.[A-Za-z0-9]+$/.test(socket)
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', PATH: process.env.PATH, PGPASSFILE: '/dev/null', ...(target ? { PGPASSWORD: decodeURIComponent(target.password) } : {}) }
  const owner = '11111111-1111-4111-8111-111111111111'
  const other = '22222222-2222-4222-8222-222222222222'
  const account = '33333333-3333-4333-8333-333333333333'
  const sibling = '44444444-4444-4444-8444-444444444444'
  const foreign = '55555555-5555-4555-8555-555555555555'
  let created = false

  const args = (db = database): string[] => {
    if (!validTarget) throw new Error('Disposable local PostgreSQL required')
    return ['-XqAt', '-v', 'ON_ERROR_STOP=1', '-h', target?.hostname ?? socket, '-p', target ? target.port || '5432' : '56489', '-U', target ? decodeURIComponent(target.username || 'postgres') : 'postgres', '-d', db]
  }
  const run = (sql: string, db = database): string => execFileSync(process.env.SUPREMO_TEST_PSQL ?? 'psql', args(db), { input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env }).trim()
  const claim = (provider: string, claimId: string, asOwner = owner, asAccount = account, expected = 'old-access'): string =>
    `SELECT public.claim_account_token_refresh('${provider}','${asAccount}','${asOwner}','${expected}','${claimId}');`
  const finish = (provider: string, claimId: string, asOwner = owner, asAccount = account, expected = 'old-access'): string =>
    `SELECT public.finish_account_token_refresh('${provider}','${asAccount}','${asOwner}','${expected}','${claimId}','new-access','new-refresh','2030-01-01T00:00:00Z');`
  const row = (provider: Provider): Record<string, unknown> => JSON.parse(run(`SELECT json_build_object('access',access_token_encrypted,'refresh',refresh_token_encrypted,'expiry',token_expires_at,'claim',token_refresh_claim,'started',token_refresh_started_at) FROM public.${provider}_accounts WHERE id='${account}'`)) as Record<string, unknown>

  beforeAll(() => {
    run(`CREATE DATABASE ${database}`, 'postgres')
    created = true
    run(`DO $$BEGIN
      IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
      IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
      IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role BYPASSRLS; END IF;
      END$$;
      CREATE SCHEMA auth;
      CREATE TABLE auth.users(id uuid PRIMARY KEY);
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT NULLIF(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      GRANT USAGE ON SCHEMA public,auth TO authenticated,anon,service_role;`)
    for (const file of ['001_initial_schema.sql', '007_token_expiry.sql', '042_account_token_refresh.sql']) {
      run(readFileSync(`supabase/migrations/${file}`, 'utf8'))
    }
    run('GRANT ALL ON public.github_accounts,public.supabase_accounts TO service_role;GRANT SELECT,UPDATE ON public.github_accounts,public.supabase_accounts TO authenticated;')
  })

  afterAll(() => { if (created) run(`DROP DATABASE ${database} WITH(FORCE)`, 'postgres') })
  beforeEach(() => {
    run(`TRUNCATE public.github_accounts,public.supabase_accounts,auth.users CASCADE;
      INSERT INTO auth.users VALUES('${owner}'),('${other}');
      INSERT INTO public.github_accounts(id,user_id,github_user_id,login,access_token_encrypted,refresh_token_encrypted,token_expires_at) VALUES
        ('${account}','${owner}',1,'owner','old-access','old-refresh','2020-01-01'),
        ('${sibling}','${owner}',2,'sibling','old-access','old-refresh','2020-01-01'),
        ('${foreign}','${other}',3,'other','old-access','old-refresh','2020-01-01');
      INSERT INTO public.supabase_accounts(id,user_id,org_name,org_slug,access_token_encrypted,refresh_token_encrypted,token_expires_at) VALUES
        ('${account}','${owner}','Owner','owner','old-access','old-refresh','2020-01-01'),
        ('${sibling}','${owner}','Sibling','sibling','old-access','old-refresh','2020-01-01'),
        ('${foreign}','${other}','Other','other','old-access','old-refresh','2020-01-01');`)
  })

  it.each(providers)('preserves %s RLS and denies refresh RPCs to browser roles', (provider) => {
    const claimId = randomUUID()
    expect(run(`SELECT relrowsecurity FROM pg_class WHERE oid='public.${provider}_accounts'::regclass`)).toBe('t')
    expect(run(`SET ROLE authenticated;SET request.jwt.claim.sub='${owner}';SELECT count(*) FROM public.${provider}_accounts`)).toBe('2')
    run(`SET ROLE authenticated;SET request.jwt.claim.sub='${other}';UPDATE public.${provider}_accounts SET access_token_encrypted='intruder' WHERE id='${account}'`)
    expect(row(provider).access).toBe('old-access')
    for (const role of ['authenticated', 'anon']) {
      expect(() => run(`SET ROLE ${role};${claim(provider, claimId)}`)).toThrow(/permission denied/)
      expect(() => run(`SET ROLE ${role};${finish(provider, claimId)}`)).toThrow(/permission denied/)
    }
    expect(run("SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace CROSS JOIN LATERAL aclexplode(p.proacl) a WHERE n.nspname='public' AND p.proname IN ('claim_account_token_refresh','finish_account_token_refresh') AND a.grantee=0 AND a.privilege_type='EXECUTE'")).toBe('0')
  })

  it.each(providers)('requires exact owner, account, provider and ciphertext for %s claims', (provider) => {
    const claimId = randomUUID()
    expect(run(`SET ROLE service_role;${claim(provider, claimId, other)}`)).toBe('f')
    expect(run(`SET ROLE service_role;${claim(provider, claimId, owner, foreign)}`)).toBe('f')
    expect(run(`SET ROLE service_role;${claim(provider, claimId, owner, account, 'stale-access')}`)).toBe('f')
    expect(run(`SET ROLE service_role;${claim('invalid', claimId)}`)).toBe('f')
    expect(run(`SET ROLE service_role;${claim(provider, claimId)}`)).toBe('t')
    expect(row(provider)).toMatchObject({ access: 'old-access', refresh: 'old-refresh', claim: claimId })
    expect(row(provider).started).toEqual(expect.any(String))
    expect(run(`SELECT count(*) FROM public.${provider}_accounts WHERE token_refresh_claim IS NOT NULL`)).toBe('1')
    const otherProvider = provider === 'github' ? 'supabase' : 'github'
    expect(run(`SELECT count(*) FROM public.${otherProvider}_accounts WHERE token_refresh_claim IS NOT NULL`)).toBe('0')
  })

  it.each(providers)('allows exactly one actual concurrent %s refresher and atomically fences completion', async (provider) => {
    const claims = [randomUUID(), randomUUID()]
    const results = await Promise.all(claims.map(claimId => execFileAsync(process.env.SUPREMO_TEST_PSQL ?? 'psql', [
      ...args(), '-c', 'BEGIN;SET LOCAL ROLE service_role', '-c', claim(provider, claimId), '-c', 'SELECT pg_sleep(0.1)', '-c', 'COMMIT',
    ], { env })))
    expect(results.map(result => result.stdout.trim()).sort()).toEqual(['f', 't'])
    const winner = row(provider).claim as string
    const loser = claims.find(claimId => claimId !== winner)!
    expect(run(`SET ROLE service_role;${finish(provider, loser)}`)).toBe('f')
    expect(run(`SET ROLE service_role;${finish(provider, winner, other)}`)).toBe('f')
    expect(run(`SET ROLE service_role;${finish(provider, winner, owner, sibling)}`)).toBe('f')
    expect(run(`SET ROLE service_role;${finish(provider, winner, owner, account, 'stale-access')}`)).toBe('f')
    expect(row(provider)).toMatchObject({ access: 'old-access', refresh: 'old-refresh', claim: winner })
    expect(run(`SET ROLE service_role;${finish(provider, winner)}`)).toBe('t')
    const saved = row(provider)
    expect(saved).toMatchObject({ access: 'new-access', refresh: 'new-refresh', claim: null, started: null })
    expect(new Date(saved.expiry as string).toISOString()).toBe('2030-01-01T00:00:00.000Z')
    expect(run(`SET ROLE service_role;${finish(provider, winner)}`)).toBe('f')
    expect(run(`SET ROLE service_role;${claim(provider, loser)}`)).toBe('f')
    expect(run(`SET ROLE service_role;${claim(provider, loser, owner, account, 'new-access')}`)).toBe('t')
  })

  it.each(providers)('retains a %s reservation indefinitely until completion or reconnect', (provider) => {
    const claimId = randomUUID()
    run(`SET ROLE service_role;${claim(provider, claimId)}`)
    run(`UPDATE public.${provider}_accounts SET token_refresh_started_at=now()-interval '30 days' WHERE id='${account}'`)
    expect(run(`SET ROLE service_role;${claim(provider, randomUUID())}`)).toBe('f')
    expect(row(provider).claim).toBe(claimId)
    expect(run(`SET ROLE service_role;${finish(provider, claimId)}`)).toBe('t')
  })

  it.each(providers)('does not overwrite a %s reconnect or a replacement refresh', (provider) => {
    const oldClaim = randomUUID()
    run(`SET ROLE service_role;${claim(provider, oldClaim)}`)
    run(`UPDATE public.${provider}_accounts SET access_token_encrypted='reconnected-access',refresh_token_encrypted='reconnected-refresh',token_refresh_claim=NULL,token_refresh_started_at=NULL WHERE id='${account}'`)
    const replacement = randomUUID()
    expect(run(`SET ROLE service_role;${claim(provider, replacement, owner, account, 'reconnected-access')}`)).toBe('t')
    expect(run(`SET ROLE service_role;${finish(provider, oldClaim)}`)).toBe('f')
    expect(row(provider)).toMatchObject({ access: 'reconnected-access', refresh: 'reconnected-refresh', claim: replacement })
    expect(run(`SET ROLE service_role;${finish(provider, replacement, owner, account, 'reconnected-access')}`)).toBe('t')
  })

  it.each(providers)('preserves the owner reconnect during a genuinely concurrent %s completion', async (provider) => {
    const claimId = randomUUID()
    run(`SET ROLE service_role;${claim(provider, claimId)}`)
    const queries = [
      finish(provider, claimId),
      `UPDATE public.${provider}_accounts SET access_token_encrypted='reconnected-access',refresh_token_encrypted='reconnected-refresh',token_refresh_claim=NULL,token_refresh_started_at=NULL WHERE id='${account}' AND user_id='${owner}'`,
    ]
    await Promise.all(queries.map(query => execFileAsync(process.env.SUPREMO_TEST_PSQL ?? 'psql', [
      ...args(), '-c', 'BEGIN;SET LOCAL ROLE service_role', '-c', query, '-c', 'SELECT pg_sleep(0.1)', '-c', 'COMMIT',
    ], { env })))
    expect(row(provider)).toMatchObject({ access: 'reconnected-access', refresh: 'reconnected-refresh', claim: null, started: null })
  })

  it.each(providers)('rejects incomplete %s reservations and invalid completion without losing old tokens', (provider) => {
    const claimId = randomUUID()
    expect(() => run(`UPDATE public.${provider}_accounts SET token_refresh_claim='${claimId}' WHERE id='${account}'`)).toThrow(/check constraint/)
    expect(() => run(`UPDATE public.${provider}_accounts SET token_refresh_started_at=now() WHERE id='${account}'`)).toThrow(/check constraint/)
    run(`SET ROLE service_role;${claim(provider, claimId)}`)
    expect(run(`SET ROLE service_role;SELECT public.finish_account_token_refresh('${provider}','${account}','${owner}','old-access','${claimId}','','new-refresh',NULL)`)).toBe('f')
    expect(row(provider)).toMatchObject({ access: 'old-access', refresh: 'old-refresh', claim: claimId })
    expect(run(`SET ROLE service_role;SELECT public.finish_account_token_refresh('${provider}','${account}','${owner}','old-access','${claimId}','new-access',NULL,NULL)`)).toBe('t')
    expect(row(provider)).toEqual({ access: 'new-access', refresh: null, expiry: null, claim: null, started: null })
  })
})
