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
