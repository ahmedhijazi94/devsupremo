import { execFile, execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest'

const execFileAsync = promisify(execFile)
describe.skipIf(!process.env.SUPREMO_MUTATION_TEST_SOCKET && !process.env.SUPREMO_TEST_DATABASE_URL)(
  'automation authority and shared receipts on PostgreSQL',
  () => {
    const socket = process.env.SUPREMO_MUTATION_TEST_SOCKET ?? ''
    const database = `supremo_policy_${randomUUID().replaceAll('-', '')}`
    const target = process.env.SUPREMO_TEST_DATABASE_URL ? new URL(process.env.SUPREMO_TEST_DATABASE_URL) : null
    const validTarget = target ? ['postgres:', 'postgresql:'].includes(target.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) && !target.search && !target.hash && target.pathname === '/postgres' : /^\/(?:private\/)?tmp\/supremo-mutations-pg\.[A-Za-z0-9]+$/.test(socket)
    const owner = '11111111-1111-4111-8111-111111111111',
      other = '22222222-2222-4222-8222-222222222222',
      project = '33333333-3333-4333-8333-333333333333',
      otherProject = '44444444-4444-4444-8444-444444444444', device = '55555555-5555-4555-8555-555555555555'
    const settings = JSON.stringify({
      enabled: true,
      capabilities: ['data.update'],
      resources: ['public.notes'],
      deviceIds: [],
      maxRows: 25,
      maxOperationsPerHour: 1,
    })
    let created = false
    const args = (db = database) => {
      if (!validTarget)
        throw new Error('Private disposable PostgreSQL socket required')
      return [
        '-X',
        '-q',
        '-A',
        '-t',
        '-v',
        'ON_ERROR_STOP=1',
        '-h',
        target?.hostname ?? socket,
        '-p',
        target ? target.port || '5432' : '56489',
        '-U',
        target ? decodeURIComponent(target.username || 'postgres') : 'postgres',
        '-d',
        db,
      ]
    }
    const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', PATH: process.env.PATH, PGPASSFILE: '/dev/null', ...(target ? { PGPASSWORD: decodeURIComponent(target.password) } : {}) }
    const run = (sql: string, db = database) =>
      execFileSync(process.env.SUPREMO_TEST_PSQL ?? 'psql', args(db), {
        input: sql,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        env,
      }).trim()
    const save = (expected: string | null = null) =>
      `SELECT public.save_project_automation_policy('${owner}','${project}','development',${expected ? `'${expected}'` : 'NULL'},'${settings}'::jsonb);`
    const claim = (
      id: string,
      policy: string,
      revision: string,
      token: string,
      digest = 'a'.repeat(64),
    ) =>
      `SELECT row_to_json(r) FROM public.claim_backend_operation('${id}','${owner}','${project}','${policy}','${revision}','data.update','${digest}','${token}') r;`
    beforeAll(() => {
      run(`CREATE DATABASE ${database}`, 'postgres')
      created = true
      run(
        `DO $$BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role BYPASSRLS; END IF; END $$;`,
      )
      run(`CREATE SCHEMA auth;CREATE TABLE auth.users(id uuid PRIMARY KEY);CREATE TABLE public.projects(id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,supabase_project_ref text,supabase_account_id uuid);ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT NULLIF(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    CREATE POLICY owner_read ON public.projects FOR SELECT TO authenticated USING(user_id=auth.uid());
    CREATE TABLE public.checkpoint_devices(id uuid PRIMARY KEY,owner_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,revoked_at timestamptz);ALTER TABLE public.checkpoint_devices ENABLE ROW LEVEL SECURITY;
    CREATE TABLE public.audit_logs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid,action text,resource_type text,resource_id uuid,metadata jsonb,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
    GRANT USAGE ON SCHEMA public,auth TO authenticated,anon,service_role;GRANT SELECT ON public.projects TO authenticated;GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;`)
      run(
        readFileSync(
          'supabase/migrations/028_project_automation_policies.sql',
          'utf8',
        ),
      )
      run(
        readFileSync(
          'supabase/migrations/029_backend_operation_receipts.sql',
          'utf8',
        ),
      )
      run(readFileSync('supabase/migrations/039_project_operation_approvals.sql','utf8'))
    })
    afterAll(() => {
      if (created) run(`DROP DATABASE ${database} WITH(FORCE)`, 'postgres')
    })
    beforeEach(() => {
      run(`TRUNCATE public.project_backend_operations,public.project_automation_policies,public.audit_logs,public.projects,auth.users CASCADE;
    INSERT INTO auth.users VALUES('${owner}'),('${other}');INSERT INTO public.projects(id,user_id,supabase_project_ref) VALUES('${project}','${owner}','ref'),('${otherProject}','${other}','other-ref');INSERT INTO public.checkpoint_devices VALUES('${device}','${owner}',NULL);`)
    })
    const requestApproval = (operation: string, policy: string, revision: string, digest = 'a'.repeat(64)) => {
      const scope = JSON.stringify({environment:'development',deviceId:device,ownerSession:false,projectRef:'ref',accountId:null,resource:'public.notes',rows:1,review:[{label:'operation',value:'insert one note'}],expiresAt:'2099-01-01T00:00:00Z'})
      return `SELECT row_to_json(r) FROM public.request_operation_approval('${owner}','${project}','${operation}','${policy}','${revision}','data.insert','${digest}','${scope}'::jsonb) r;`
    }
    const decide = (id:string, decision='approved') => `SELECT public.decide_operation_approval('${owner}','${project}','${id}','${decision}');`
    const prepareApproval = () => {
      const revision=run(`SET ROLE service_role;${save()}`),policy=run('SELECT id FROM public.project_automation_policies'),operation=randomUUID()
      const proposal=JSON.parse(run(`SET ROLE service_role;${requestApproval(operation,policy,revision)}`)) as {id:string;status:string;expires_at:string}
      const dispatch=(token=randomUUID(),digest='a'.repeat(64))=>claim(operation,policy,revision,token,digest).replace("'data.update'","'data.insert'")
      return {revision,policy,operation,proposal,dispatch}
    }
    it('allows only owner approval, creates no receipt before consent, and enforces a fixed lifetime',()=>{
      const f=prepareApproval()
      expect(f.proposal.status).toBe('pending')
      expect(Date.parse(f.proposal.expires_at)-Date.now()).toBeLessThanOrEqual(15*60_000)
      expect(run('SELECT count(*) FROM public.project_backend_operations')).toBe('0')
      expect(()=>run(`SET ROLE service_role;${f.dispatch()}`)).toThrow(/approval required/)
      expect(run(`SET ROLE authenticated;SET request.jwt.claim.sub='${other}';SELECT count(*) FROM public.project_operation_approvals`)).toBe('0')
      expect(run(`SET ROLE authenticated;SET request.jwt.claim.sub='${owner}';SELECT count(*) FROM public.project_operation_approvals`)).toBe('1')
      expect(()=>run(`SET ROLE authenticated;${decide(f.proposal.id)}`)).toThrow(/permission denied/)
      expect(()=>run(`SET ROLE authenticated;UPDATE public.project_operation_approvals SET status='approved'`)).toThrow(/permission denied/)
      expect(()=>run(`SET ROLE service_role;${decide(f.proposal.id).replace(`'${owner}'`,`'${other}'`)}`)).toThrow(/not owned/)
      run(`SET ROLE service_role;${decide(f.proposal.id)}`)
      expect(run('SELECT action FROM public.audit_logs ORDER BY created_at DESC LIMIT 1')).toBe('automation.operation.approved')
    })
    it('binds the exact digest, device, target and policy revision and consumes consent atomically',()=>{
      const f=prepareApproval()
      expect(()=>run(`SET ROLE service_role;${requestApproval(f.operation,f.policy,f.revision,'b'.repeat(64))}`)).toThrow(/operation conflict/)
      run(`SET ROLE service_role;${decide(f.proposal.id)}`)
      expect(()=>run(`SET ROLE service_role;${f.dispatch(randomUUID(),'b'.repeat(64))}`)).toThrow(/approval required/)
      const token=randomUUID(),receipt=JSON.parse(run(`SET ROLE service_role;${f.dispatch(token)}`)) as {claim_token:string}
      expect(receipt.claim_token).toBe(token)
      expect(run('SELECT status FROM public.project_operation_approvals')).toBe('consumed')
      expect(JSON.parse(run(`SET ROLE service_role;${f.dispatch()}`)).claim_token).toBe(token)
      expect(run('SELECT count(*) FROM public.project_backend_operations')).toBe('1')
      expect(()=>run(`SET ROLE service_role;${f.dispatch().replace(f.operation,randomUUID())}`)).toThrow(/approval required/)
      run(`SET ROLE service_role;${decide(f.proposal.id,'revoked')}`)
      expect(()=>run(`SET ROLE service_role;${f.dispatch()}`)).toThrow(/approval required/)
    })
    it.each(['policy','expiry','device','target'])('fences one-time consent after %s changes',kind=>{
      const f=prepareApproval();run(`SET ROLE service_role;${decide(f.proposal.id)}`)
      if(kind==='policy')run('UPDATE public.project_automation_policies SET revision=gen_random_uuid()')
      if(kind==='expiry')run("UPDATE public.project_operation_approvals SET expires_at=now()-interval '1 second'")
      if(kind==='device')run('UPDATE public.checkpoint_devices SET revoked_at=now()')
      if(kind==='target')run("UPDATE public.projects SET supabase_project_ref='changed' WHERE supabase_project_ref='ref'")
      expect(()=>run(`SET ROLE service_role;${f.dispatch()}`)).toThrow(/authorization changed|approval required/)
      expect(run('SELECT count(*) FROM public.project_backend_operations')).toBe('0')
    })
    it('reserves only one dispatch under concurrent approved retries',async()=>{
      const f=prepareApproval();run(`SET ROLE service_role;${decide(f.proposal.id)}`)
      const replies=await Promise.all([0,1].map(()=>execFileAsync(process.env.SUPREMO_TEST_PSQL??'psql',[...args(),'-c',`SET ROLE service_role;${f.dispatch()}`],{env})))
      const receipts=replies.map(reply=>JSON.parse(reply.stdout.trim()) as {claim_token:string})
      expect(receipts[0]!.claim_token).toBe(receipts[1]!.claim_token)
      expect(run('SELECT count(*) FROM public.project_backend_operations')).toBe('1')
    })
    it('keeps owner read access while denying cross-owner reads, direct grants and device-style authenticated writes', () => {
      run(`SET ROLE service_role;${save()}`)
      expect(
        run(
          `SET ROLE authenticated;SET request.jwt.claim.sub='${owner}';SELECT count(*) FROM public.project_automation_policies;`,
        ),
      ).toBe('1')
      expect(
        run(
          `SET ROLE authenticated;SET request.jwt.claim.sub='${other}';SELECT count(*) FROM public.project_automation_policies;`,
        ),
      ).toBe('0')
      expect(() =>
        run(
          `SET ROLE authenticated;UPDATE public.project_automation_policies SET enabled=true;`,
        ),
      ).toThrow(/permission denied/)
      expect(() => run(`SET ROLE authenticated;${save()}`)).toThrow(
        /permission denied/,
      )
      expect(() =>
        run(
          `SET ROLE service_role;${save().replace(`'${project}'`, `'${otherProject}'`)}`,
        ),
      ).toThrow(/not owned/)
    })
    it('compares policy revisions and commits the update and audit together', () => {
      const first = run(`SET ROLE service_role;${save()}`)
      expect(() => run(`SET ROLE service_role;${save()}`)).toThrow(
        /revision changed/,
      )
      const second = run(`SET ROLE service_role;${save(first)}`)
      expect(second).not.toBe(first)
      expect(run('SELECT count(*) FROM public.audit_logs')).toBe('2')
      expect(() => run(`SET ROLE service_role;${save(first)}`)).toThrow(
        /revision changed/,
      )
      expect(run('SELECT count(*) FROM public.audit_logs')).toBe('2')
    })
    it('returns the original claim once, refuses conflicting inputs and fences stale execution', () => {
      const revision = run(`SET ROLE service_role;${save()}`),
        policy = run('SELECT id FROM public.project_automation_policies'),
        id = randomUUID(),
        token = randomUUID()
      const first = JSON.parse(
        run(`SET ROLE service_role;${claim(id, policy, revision, token)}`),
      ) as { claim_token: string; state: string }
      const again = JSON.parse(
        run(
          `SET ROLE service_role;${claim(id, policy, revision, randomUUID())}`,
        ),
      ) as { claim_token: string; state: string }
      expect(first.claim_token).toBe(token)
      expect(again.claim_token).toBe(token)
      expect(() =>
        run(
          `SET ROLE service_role;${claim(id, policy, revision, randomUUID(), 'b'.repeat(64))}`,
        ),
      ).toThrow(/idempotency/)
      run(
        `UPDATE public.project_backend_operations SET lease_expires_at=now()-interval '1 second',state='running' WHERE id='${id}'`,
      )
      expect(
        JSON.parse(
          run(
            `SET ROLE service_role;${claim(id, policy, revision, randomUUID())}`,
          ),
        ),
      ).toMatchObject({ state: 'uncertain', claim_token: token })
      expect(
        run(
          `SET ROLE authenticated;SET request.jwt.claim.sub='${other}';SELECT count(*) FROM public.project_backend_operations`,
        ),
      ).toBe('0')
    })
    it('serializes a shared hourly budget across concurrent server processes', async () => {
      const revision = run(`SET ROLE service_role;${save()}`),
        policy = run('SELECT id FROM public.project_automation_policies')
      const results = await Promise.allSettled(
        [0, 1].map(() =>
          execFileAsync(
            process.env.SUPREMO_TEST_PSQL ?? 'psql',
            [
              ...args(),
              '-c',
              `BEGIN;SET ROLE service_role;${claim(randomUUID(), policy, revision, randomUUID())}SELECT pg_sleep(0.05);COMMIT;`,
            ],
            { env },
          ),
        ),
      )
      expect(
        results.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1)
      expect(
        results.filter((result) => result.status === 'rejected'),
      ).toHaveLength(1)
      expect(
        run('SELECT count(*) FROM public.project_backend_operations'),
      ).toBe('1')
    })
    it('revocation prevents another claim and an unrelated owner cannot use the policy', () => {
      const revision = run(`SET ROLE service_role;${save()}`),
        policy = run('SELECT id FROM public.project_automation_policies')
      expect(() =>
        run(
          `SET ROLE service_role;${claim(randomUUID(), policy, revision, randomUUID()).replace(`'${owner}'`, `'${other}'`)}`,
        ),
      ).toThrow(/authorization changed/)
      run(
        `UPDATE public.project_automation_policies SET enabled=false,revision=gen_random_uuid()`,
      )
      expect(() =>
        run(
          `SET ROLE service_role;${claim(randomUUID(), policy, revision, randomUUID())}`,
        ),
      ).toThrow(/authorization changed/)
    })
  },
)
