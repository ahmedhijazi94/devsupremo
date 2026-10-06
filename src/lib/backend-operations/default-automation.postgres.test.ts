import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { developmentCapabilities } from './contract'

interface StoredPolicy {
  id: string
  user_id: string
  project_id: string
  environment: string
  revision: string
  enabled: boolean
  capabilities: string[]
  resources: string[]
  device_ids: string[]
  max_rows: number
  max_operations_per_hour: number
}

describe.skipIf(!process.env.SUPREMO_MUTATION_TEST_SOCKET && !process.env.SUPREMO_TEST_DATABASE_URL)(
  'default development automation on disposable PostgreSQL',
  () => {
    const socket = process.env.SUPREMO_MUTATION_TEST_SOCKET ?? ''
    const database = `supremo_default_automation_${randomUUID().replaceAll('-', '')}`
    const target = process.env.SUPREMO_TEST_DATABASE_URL ? new URL(process.env.SUPREMO_TEST_DATABASE_URL) : null
    const validTarget = target
      ? ['postgres:', 'postgresql:'].includes(target.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) && !target.search && !target.hash && target.pathname === '/postgres'
      : /^\/(?:private\/)?tmp\/supremo-mutations-pg\.[A-Za-z0-9]+$/.test(socket)
    const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', PATH: process.env.PATH, PGPASSFILE: '/dev/null', ...(target ? { PGPASSWORD: decodeURIComponent(target.password) } : {}) }
    const owner = '11111111-1111-4111-8111-111111111111'
    const other = '22222222-2222-4222-8222-222222222222'
    const legacyWithoutPolicy = '33333333-3333-4333-8333-333333333333'
    const legacyRestricted = '44444444-4444-4444-8444-444444444444'
    const device = '55555555-5555-4555-8555-555555555555'
    let created = false
    let legacyPolicies = ''

    const args = (db = database): string[] => {
      if (!validTarget) throw new Error('Disposable local PostgreSQL required')
      return ['-XqAt', '-v', 'ON_ERROR_STOP=1', '-h', target?.hostname ?? socket, '-p', target ? target.port || '5432' : '56489', '-U', target ? decodeURIComponent(target.username || 'postgres') : 'postgres', '-d', db]
    }
    const run = (sql: string, db = database): string => execFileSync(process.env.SUPREMO_TEST_PSQL ?? 'psql', args(db), { input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env }).trim()
    const ownerSession = (sql: string, user = owner): string => run(`SET ROLE authenticated; SET request.jwt.claim.sub='${user}'; ${sql}`)
    const insert = (id: string, user = owner): string => `INSERT INTO public.projects(id,user_id,name) VALUES('${id}','${user}','New project') RETURNING id;`
    const policy = (id: string): StoredPolicy => JSON.parse(run(`SELECT row_to_json(p) FROM public.project_automation_policies p WHERE project_id='${id}' AND environment='development'`)) as StoredPolicy
    const policySnapshot = (): string => run(`SELECT json_agg(p ORDER BY environment) FROM public.project_automation_policies p WHERE project_id='${legacyRestricted}'`)
    const save = (id: string, environment: string, expected: string | null, settings: Record<string, unknown>): string =>
      `SELECT public.save_project_automation_policy('${owner}','${id}','${environment}',${expected ? `'${expected}'` : 'NULL'},'${JSON.stringify(settings)}'::jsonb);`
    const restrictedSettings = {
      enabled: false,
      capabilities: ['data.read'],
      resources: ['engine.tools'],
      deviceIds: [device],
      maxRows: 5,
      maxOperationsPerHour: 7,
    }

    beforeAll(() => {
      run(`CREATE DATABASE ${database}`, 'postgres')
      created = true
      run(`DO $$BEGIN
        IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
        IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
        IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role BYPASSRLS; END IF;
        END $$;
        CREATE SCHEMA auth;
        CREATE TABLE auth.users(id uuid PRIMARY KEY);
        CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT NULLIF(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
        CREATE TABLE public.projects(id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,name text NOT NULL);
        ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;
        CREATE POLICY owner_read ON public.projects FOR SELECT TO authenticated USING(user_id=auth.uid());
        CREATE POLICY owner_insert ON public.projects FOR INSERT TO authenticated WITH CHECK(user_id=auth.uid());
        CREATE POLICY owner_update ON public.projects FOR UPDATE TO authenticated USING(user_id=auth.uid()) WITH CHECK(user_id=auth.uid());
        CREATE TABLE public.audit_logs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid,action text,resource_type text,resource_id uuid,metadata jsonb,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
        ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;
        GRANT USAGE ON SCHEMA public,auth TO authenticated,anon,service_role;
        GRANT SELECT,INSERT,UPDATE ON public.projects TO authenticated;
        GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
        INSERT INTO auth.users VALUES('${owner}'),('${other}');
        INSERT INTO public.projects(id,user_id,name) VALUES('${legacyWithoutPolicy}','${owner}','Legacy without policy'),('${legacyRestricted}','${owner}','Legacy restricted');`)
      run(readFileSync('supabase/migrations/028_project_automation_policies.sql', 'utf8'))
      run(`SET ROLE service_role; ${save(legacyRestricted, 'development', null, restrictedSettings)} ${save(legacyRestricted, 'production', null, restrictedSettings)}`)
      legacyPolicies = policySnapshot()
      run(readFileSync('supabase/migrations/043_default_development_automation.sql', 'utf8'))
    })

    afterAll(() => { if (created) run(`DROP DATABASE ${database} WITH(FORCE)`, 'postgres') })

    it('creates an audited full development policy in the owner project INSERT transaction', () => {
      const id = randomUUID()
      expect(ownerSession(insert(id))).toBe(id)
      const saved = policy(id)
      expect(saved).toMatchObject({
        user_id: owner,
        project_id: id,
        environment: 'development',
        enabled: true,
        resources: [],
        device_ids: [],
        max_rows: 25,
        max_operations_per_hour: 60,
      })
      expect(saved.capabilities).toEqual(developmentCapabilities)
      expect(new Set(saved.capabilities).size).toBe(developmentCapabilities.length)
      expect(run(`SELECT count(*) FROM public.project_automation_policies WHERE project_id='${id}'`)).toBe('1')
      const audit = JSON.parse(run(`SELECT row_to_json(a) FROM public.audit_logs a WHERE resource_id='${id}'`)) as Record<string, unknown>
      expect(audit).toMatchObject({ user_id: owner, action: 'automation.policy.saved', resource_type: 'project', resource_id: id, metadata: { environment: 'development', revision: saved.revision, enabled: true, capabilities: developmentCapabilities } })
    })

    it('preserves project RLS, isolates grants by owner, and rejects spoofed project owners', () => {
      const id = randomUUID(), forgedId = randomUUID()
      ownerSession(insert(id))
      expect(ownerSession(`SELECT count(*) FROM public.project_automation_policies WHERE project_id='${id}'`)).toBe('1')
      expect(ownerSession(`SELECT count(*) FROM public.project_automation_policies WHERE project_id='${id}'`, other)).toBe('0')
      expect(() => ownerSession(insert(forgedId, owner), other)).toThrow(/row-level security/)
      expect(run(`SELECT count(*) FROM public.projects WHERE id='${forgedId}'`)).toBe('0')
      expect(run(`SELECT count(*) FROM public.project_automation_policies WHERE project_id='${forgedId}'`)).toBe('0')
      expect(run(`SELECT count(*) FROM public.audit_logs WHERE resource_id='${forgedId}'`)).toBe('0')
      expect(run("SELECT bool_and(relrowsecurity) FROM pg_class WHERE oid IN ('public.projects'::regclass,'public.project_automation_policies'::regclass)")).toBe('t')
    })

    it('supports server provisioning without a user JWT while rejecting a mismatched privileged session', () => {
      const id = randomUUID(), forgedId = randomUUID()
      expect(run(`SET ROLE service_role; ${insert(id)}`)).toBe(id)
      expect(policy(id).user_id).toBe(owner)
      expect(() => run(`SET ROLE service_role; SET request.jwt.claim.sub='${other}'; ${insert(forgedId)}`)).toThrow(/project not owned/)
      expect(run(`SELECT count(*) FROM public.projects WHERE id='${forgedId}'`)).toBe('0')
      expect(run(`SELECT count(*) FROM public.project_automation_policies WHERE project_id='${forgedId}'`)).toBe('0')
    })

    it('keeps direct policy mutation and trigger invocation unavailable to browser roles', () => {
      const id = randomUUID()
      ownerSession(insert(id))
      const saved = policy(id)
      for (const role of ['authenticated', 'anon']) {
        for (const sql of [
          `UPDATE public.project_automation_policies SET enabled=false WHERE project_id='${id}';`,
          `DELETE FROM public.project_automation_policies WHERE project_id='${id}';`,
          `INSERT INTO public.project_automation_policies(user_id,project_id,environment) VALUES('${owner}','${id}','production');`,
          save(id, 'development', saved.revision, restrictedSettings),
          'SELECT public.initialize_project_development_automation();',
        ]) expect(() => run(`SET ROLE ${role}; SET request.jwt.claim.sub='${owner}'; ${sql}`)).toThrow(/permission denied/)
      }
      expect(policy(id)).toEqual(saved)
      expect(run("SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace CROSS JOIN LATERAL aclexplode(p.proacl) a WHERE n.nspname='public' AND p.proname='initialize_project_development_automation' AND a.grantee=0 AND a.privilege_type='EXECUTE'")).toBe('0')
    })

    it('does not backfill or replace existing restrictions, revocations, or production settings', () => {
      expect(policySnapshot()).toBe(legacyPolicies)
      expect(run(`SELECT count(*) FROM public.project_automation_policies WHERE project_id='${legacyWithoutPolicy}'`)).toBe('0')
      ownerSession(`UPDATE public.projects SET name='Renamed legacy project' WHERE id IN ('${legacyWithoutPolicy}','${legacyRestricted}')`)
      expect(policySnapshot()).toBe(legacyPolicies)
      expect(run(`SELECT count(*) FROM public.project_automation_policies WHERE project_id='${legacyWithoutPolicy}'`)).toBe('0')
      expect(run(`SELECT count(*) FROM public.audit_logs WHERE resource_id='${legacyRestricted}'`)).toBe('2')
    })

    it('preserves an owner revocation and its revision after later project updates', () => {
      const id = randomUUID()
      ownerSession(insert(id))
      const initial = policy(id)
      run(`SET ROLE service_role; ${save(id, 'development', initial.revision, restrictedSettings)}`)
      const revoked = policy(id)
      expect(revoked.enabled).toBe(false)
      expect(revoked.revision).not.toBe(initial.revision)
      ownerSession(`UPDATE public.projects SET name='Renamed revoked project' WHERE id='${id}'`)
      expect(policy(id)).toEqual(revoked)
      expect(() => run(`SET ROLE service_role; ${save(id, 'development', null, restrictedSettings)}`)).toThrow(/policy revision changed/)
      expect(policy(id)).toEqual(revoked)
    })

    it.each(['policy', 'audit'] as const)('rolls back the project and grant when the %s write fails', (failure) => {
      const id = randomUUID()
      const table = failure === 'policy' ? 'project_automation_policies' : 'audit_logs'
      const column = failure === 'policy' ? 'project_id' : 'resource_id'
      run(`ALTER TABLE public.${table} ADD CONSTRAINT reject_test_project CHECK(${column}<>'${id}')`)
      try {
        expect(() => ownerSession(insert(id))).toThrow(/reject_test_project/)
        expect(run(`SELECT count(*) FROM public.projects WHERE id='${id}'`)).toBe('0')
        expect(run(`SELECT count(*) FROM public.project_automation_policies WHERE project_id='${id}'`)).toBe('0')
        expect(run(`SELECT count(*) FROM public.audit_logs WHERE resource_id='${id}'`)).toBe('0')
      } finally {
        run(`ALTER TABLE public.${table} DROP CONSTRAINT reject_test_project`)
      }
    })
  },
)
