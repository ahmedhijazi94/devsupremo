/** Run after test-restore-recovery in an empty disposable local PostgreSQL cluster. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const target = process.env.SUPREMO_TEST_DATABASE_URL
if (!target || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(target).hostname)) throw new Error('Use o PostgreSQL local descartável dos testes de migrations.')
const run = (sql: string) => execFileSync(process.env.SUPREMO_TEST_PSQL ?? 'psql', [target, '-XqAt', '-v', 'ON_ERROR_STOP=1'], { input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const user = (n: number, sql: string) => run(`SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub','${id(n)}',false); ${sql}`).split('\n').slice(1).join('\n')
// Require the disposable fixtures; do not reset any existing schema or data.
assert.equal(run(`SELECT count(*) FROM projects WHERE id IN ('${id(11)}','${id(22)}') AND name IN ('Scratch A','Scratch B');`), '2')
assert.equal(run("SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='secret_requests' AND column_name='target';"), '0')
run(`INSERT INTO secret_requests(id,project_id,user_id,name) VALUES ('${id(201)}','${id(11)}','${id(1)}','LEGACY_API_KEY');`)
run(`INSERT INTO secret_requests(id,project_id,user_id,name) VALUES ('${id(205)}','${id(22)}','${id(1)}','LEGACY_FORGED_OWNER');`)
run(readFileSync(new URL('../supabase/migrations/024_scoped_secret_requests.sql', import.meta.url), 'utf8'))

assert.equal(run(`SELECT status||':'||(target IS NULL)::text||':'||(updated_at IS NOT NULL)::text FROM secret_requests WHERE id='${id(201)}';`), 'pending:true:true')
const insert = (row: number, project = 11, owner = 1, environment = 'preview', name = 'PAYMENTS_API_KEY', account = 301) => `INSERT INTO secret_requests(id,project_id,user_id,name,target,environment,target_ref,target_account_id) VALUES ('${id(row)}','${id(project)}','${id(owner)}','${name}','vercel','${environment}','prj_scratch','${id(account)}');`
const backend = (sql: string) => run(`SET ROLE service_role; ${sql}`)
backend(insert(202))
backend(insert(203, 11, 1, 'production'))
assert.equal(user(1, 'SELECT count(*) FROM secret_requests;'), '3')
assert.equal(user(2, 'SELECT count(*) FROM secret_requests;'), '0')
assert.equal(run('SET ROLE anon; SELECT count(*) FROM secret_requests;'), '0')
assert.throws(() => user(1, insert(204, 22, 1)), /permission denied/)
assert.throws(() => user(1, insert(204)), /permission denied/)
assert.throws(() => user(2, insert(204, 11, 2)), /permission denied/)
assert.throws(() => run(`SET ROLE anon; ${insert(204)}`), /permission denied/)
assert.throws(() => user(1, `UPDATE secret_requests SET status='fulfilled' WHERE id='${id(202)}';`), /permission denied/)
assert.throws(() => user(2, `UPDATE secret_requests SET status='fulfilled' WHERE id='${id(202)}';`), /permission denied/)
assert.equal(user(2, `DELETE FROM secret_requests WHERE id='${id(202)}' RETURNING id;`), '')
assert.throws(() => user(1, `UPDATE secret_requests SET target_ref='retargeted' WHERE id='${id(202)}';`), /permission denied/)
assert.throws(() => backend(insert(204)), /duplicate key/)
assert.throws(() => backend(insert(204, 11, 1, 'preview', 'NEXT_PUBLIC_PAYMENTS_KEY')), /check constraint/)
assert.throws(() => backend(`UPDATE secret_requests SET target='supabase' WHERE id='${id(202)}';`), /check constraint/)
assert.throws(() => backend(`UPDATE secret_requests SET target_ref=NULL WHERE id='${id(202)}';`), /check constraint/)
assert.throws(() => backend(`UPDATE secret_requests SET is_secret=false WHERE id='${id(202)}';`), /check constraint/)
// Supabase uses its explicit registered environment; never Vercel's preview target.
backend(`UPDATE secret_requests SET target='supabase',environment='development',target_ref='scratch-ref' WHERE id='${id(202)}';`)
assert.throws(() => backend(`UPDATE secret_requests SET name='SUPABASE_SERVICE_ROLE_KEY' WHERE id='${id(202)}';`), /check constraint/)
assert.equal(user(1, `DELETE FROM secret_requests WHERE id='${id(203)}' RETURNING id;`), id(203))
assert.equal(run("SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='secret_requests' AND column_name IN ('value','secret_value','encrypted_value','token');"), '0')
assert.equal(run("SELECT relrowsecurity FROM pg_class WHERE oid='public.secret_requests'::regclass;"), 't')
assert.equal(run("SELECT count(*) FROM pg_indexes WHERE schemaname='public' AND indexname='idx_secret_requests_target_account';"), '1')
console.log('✓ PostgreSQL real: migration024 preserva legado; RLS isola usuários/projetos; status e destino só podem ser escritos pelo backend; destino/ambiente/nome/duplicação validados; tabela contém apenas metadados.')

run(readFileSync(new URL('../supabase/migrations/025_secret_request_configuration.sql', import.meta.url), 'utf8'))
assert.equal(run(`SELECT count(*) FROM secret_requests WHERE id IN ('${id(201)}','${id(202)}','${id(205)}') AND configuration IS NULL;`), '3')
const smtp = { kind: 'supabase-smtp', provider: 'resend', senderEmail: 'account@example.test', senderName: 'Scratch App' }
const password = { kind: 'supabase-user-password', userId: id(401) }
const sqlJson = (value: unknown) => `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`
const configure = (value: unknown, environment = 'development', destination = 'supabase') => `UPDATE secret_requests SET target='${destination}',environment='${environment}',configuration=${sqlJson(value)} WHERE id='${id(202)}';`
backend(configure(smtp))
assert.equal(user(1, `SELECT configuration->>'senderEmail' FROM secret_requests WHERE id='${id(202)}';`), smtp.senderEmail)
assert.equal(user(2, 'SELECT count(*) FROM secret_requests;'), '0')
assert.equal(run('SET ROLE anon; SELECT count(*) FROM secret_requests;'), '0')
assert.equal(user(2, `DELETE FROM secret_requests WHERE id='${id(202)}' RETURNING id;`), '')
for (const actor of [1, 2]) {
  assert.throws(() => user(actor, configure(password)), /permission denied/)
  assert.throws(() => user(actor, `UPDATE secret_requests SET status='fulfilled' WHERE id='${id(202)}';`), /permission denied/)
  assert.throws(() => user(actor, insert(206)), /permission denied/)
}
assert.throws(() => run(`SET ROLE anon; ${configure(password)}`), /permission denied/)
assert.throws(() => run(`SET ROLE anon; ${insert(206)}`), /permission denied/)
backend(configure(smtp, 'production'))
assert.equal(run(`SELECT configuration->>'provider' FROM secret_requests WHERE id='${id(202)}';`), 'resend')
for (const malformed of [null, [], {}, { kind: 'unknown' }, { ...smtp, provider: 'untrusted' }, { ...smtp, senderName: '' },
  { ...smtp, senderName: 'a\nb' }, { ...smtp, senderName: 'x'.repeat(101) }, { ...smtp, senderName: 12 },
  { ...smtp, senderEmail: 'invalid' }, { ...smtp, senderEmail: 'a\nb@example.test' }, { ...smtp, senderEmail: null },
  { ...smtp, smtp_pass: 'synthetic-test-key' }, { ...smtp, value: 'synthetic-test-key' }, { ...smtp, token: 'synthetic-test-key' },
  { ...password, userId: 'not-a-user-id' }, { ...password, password: 'synthetic-test-password' }, { ...password, userId: null },
  { kind: 'supabase-user-password' }]) assert.throws(() => backend(configure(malformed)), /check constraint/)
assert.throws(() => backend(configure(smtp, 'preview')), /check constraint/)
assert.throws(() => backend(configure(smtp, 'development', 'vercel')), /check constraint/)
assert.throws(() => backend(configure(password, 'production')), /check constraint/)
assert.throws(() => backend(configure(password, 'preview')), /check constraint/)
assert.throws(() => backend(configure(password, 'development', 'vercel')), /check constraint/)
backend(configure(password))
assert.equal(user(1, `SELECT configuration->>'userId' FROM secret_requests WHERE id='${id(202)}';`), id(401))
const acquireClaim = (claim: number) => `UPDATE secret_requests SET delivery_claim_id='${id(claim)}',delivery_claim_expires_at=now()+interval '120 seconds'
  WHERE id='${id(202)}' AND project_id='${id(11)}' AND user_id='${id(1)}' AND status='pending'
    AND (delivery_claim_id IS NULL OR delivery_claim_expires_at<=now()) RETURNING delivery_claim_id;`
assert.equal(backend(acquireClaim(501)), id(501))
assert.equal(backend(acquireClaim(502)), '')
assert.equal(user(1, `DELETE FROM secret_requests WHERE id='${id(202)}' RETURNING id;`), '')
assert.equal(user(2, `DELETE FROM secret_requests WHERE id='${id(202)}' RETURNING id;`), '')
assert.equal(backend(`DELETE FROM secret_requests WHERE id='${id(202)}' AND (delivery_claim_id IS NULL OR delivery_claim_expires_at<=now()) RETURNING id;`), '')
assert.throws(() => user(1, `UPDATE secret_requests SET delivery_claim_expires_at=now()-interval '1 second' WHERE id='${id(202)}';`), /permission denied/)
assert.throws(() => user(2, `UPDATE secret_requests SET delivery_claim_id=NULL,delivery_claim_expires_at=NULL WHERE id='${id(202)}';`), /permission denied/)
assert.throws(() => backend(`UPDATE secret_requests SET status='fulfilled' WHERE id='${id(202)}';`), /check constraint/)
assert.throws(() => backend(`UPDATE secret_requests SET delivery_claim_id=NULL WHERE id='${id(202)}';`), /check constraint/)
backend(`UPDATE secret_requests SET delivery_claim_expires_at=now()-interval '1 second' WHERE id='${id(202)}';`)
assert.equal(backend(acquireClaim(502)), id(502))
assert.equal(backend(`UPDATE secret_requests SET delivery_claim_id=NULL,delivery_claim_expires_at=NULL WHERE id='${id(202)}' AND delivery_claim_id='${id(501)}' RETURNING id;`), '')
assert.equal(backend(`UPDATE secret_requests SET status='fulfilled',delivery_claim_id=NULL,delivery_claim_expires_at=NULL WHERE id='${id(202)}' AND delivery_claim_id='${id(501)}' RETURNING id;`), '')
assert.equal(run(`SELECT status||':'||delivery_claim_id::text FROM secret_requests WHERE id='${id(202)}';`), `pending:${id(502)}`)
backend(`UPDATE secret_requests SET delivery_claim_id=NULL,delivery_claim_expires_at=NULL WHERE id='${id(202)}' AND delivery_claim_id='${id(502)}';`)
assert.equal(user(1, `SELECT configuration->>'userId' FROM secret_requests WHERE id='${id(202)}';`), id(401))
backend(`UPDATE secret_requests SET configuration=NULL WHERE id='${id(202)}';`)
assert.equal(user(1, `SELECT configuration IS NULL FROM secret_requests WHERE id='${id(202)}';`), 't')
// Ordinary API-key fields use the same reservation semantics as configured operations.
assert.equal(backend(acquireClaim(504)), id(504))
assert.equal(backend(acquireClaim(505)), '')
assert.equal(user(1, `DELETE FROM secret_requests WHERE id='${id(202)}' RETURNING id;`), '')
backend(`UPDATE secret_requests SET delivery_claim_id=NULL,delivery_claim_expires_at=NULL WHERE id='${id(202)}' AND delivery_claim_id='${id(504)}';`)
assert.equal(run("SELECT relrowsecurity FROM pg_class WHERE oid='public.secret_requests'::regclass;"), 't')
assert.equal(run("SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='secret_requests' AND cmd IN ('INSERT','UPDATE','ALL');"), '0')
assert.equal(run("SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='secret_requests' AND column_name IN ('value','secret_value','encrypted_value','token','password','smtp_pass');"), '0')
backend(configure(password))
assert.equal(backend(acquireClaim(503)), id(503))
backend(`UPDATE secret_requests SET delivery_claim_expires_at=now()-interval '1 second' WHERE id='${id(202)}';`)
assert.equal(user(1, `DELETE FROM secret_requests WHERE id='${id(202)}' RETURNING id;`), id(202))
console.log('✓ PostgreSQL real: migration025 preserva legado e RLS; intenção de SMTP/senha aceita somente metadados; claims exclusivos bloqueiam dispensa em andamento e permitem recuperação após expiração; worker antigo não confirma nem libera claim novo; valores/chaves extras e escritas do browser rejeitados.')
