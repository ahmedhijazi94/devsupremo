/** Real disposable PostgreSQL: no hosted account, credentials or app data. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'

const target = process.env.SUPREMO_TEST_DATABASE_URL
if (!target || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(target).hostname)) throw new Error('Use um PostgreSQL local descartável vazio.')
const psql = process.env.SUPREMO_TEST_PSQL ?? 'psql'
const args = [target, '-XqAt', '-v', 'ON_ERROR_STOP=1']
const run = (sql: string) => execFileSync(psql, args, { input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const sha = 'a'.repeat(40)
const migration = (name: string) => readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8')

// Fail before touching an existing application schema.
assert.equal(run("select to_regclass('public.projects') is null and to_regnamespace('auth') is null;"), 't')
run(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
create schema auth; create table auth.users(id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
create table public.projects(id uuid primary key,user_id uuid references auth.users(id) on delete cascade);
create function public.update_updated_at() returns trigger language plpgsql as $$ begin new.updated_at=now(); return new; end $$;
${migration('016_checkpoint_daemon.sql')}
${migration('017_checkpoint_history_restore.sql')}
${migration('020_checkpoint_local_reports.sql')}
${migration('021_checkpoint_publication_order.sql')}
grant usage on schema public, auth to authenticated, anon, service_role;
grant select, insert, update, delete on all tables in schema public to authenticated, anon, service_role;
insert into auth.users values('${id(1)}'),('${id(2)}');
insert into projects(id,user_id) values('${id(11)}','${id(1)}'),('${id(22)}','${id(2)}');
insert into checkpoint_devices(id,owner_user_id,secret_hash) values('${id(31)}','${id(1)}','not-a-secret-hash-a'),('${id(32)}','${id(2)}','not-a-secret-hash-b');`)

const reportSql = (over: { checkpoint?: number; project?: number; device?: number; revision?: number; commit?: string; validation?: string; validated?: string | null; createdAt?: string } = {}) => {
  const validated = over.validated === null ? 'null' : `'${over.validated ?? sha}'`
  const createdAt = over.createdAt ? `'${over.createdAt}'::timestamptz` : 'now()'
  return `select public.report_local_checkpoint('${id(over.checkpoint ?? 41)}','${id(over.project ?? 11)}','${id(over.device ?? 31)}','${over.commit ?? sha}',${createdAt},${over.revision ?? 1},'${over.validation ?? 'pending'}',${validated},'local');`
}
const report = (over: Parameters<typeof reportSql>[0] = {}) => run(`set role service_role; ${reportSql(over)}`)
assert.equal(report(), 'recorded')
assert.equal(report(), 'ignored')
assert.equal(report({ revision: 3, validation: 'failed' }), 'recorded')
assert.equal(report({ revision: 2, validation: 'passed' }), 'ignored')
assert.equal(run(`select local_validation_status||':'||local_report_revision||':'||push_status from checkpoints where id='${id(41)}';`), 'failed:3:local')
assert.equal(report({ revision: 4, project: 22, device: 32 }), 'conflict')
assert.equal(report({ checkpoint: 42, project: 22 }), 'conflict')
assert.equal(report({ revision: 4, commit: 'b'.repeat(40), validated: 'b'.repeat(40) }), 'conflict')
assert.equal(report({ checkpoint: 43, validated: 'b'.repeat(40) }), 'conflict')
assert.equal(report({ checkpoint: 44, validation: 'passed', validated: null }), 'conflict')
run(`update checkpoint_devices set revoked_at=now() where id='${id(31)}';`)
assert.equal(report({ revision: 4 }), 'conflict')
run(`update checkpoint_devices set revoked_at=null where id='${id(31)}';`)
for (const role of ['anon', 'authenticated']) assert.throws(() => run(`set role ${role}; ${reportSql()}`))
const asUser = (user: number, sql: string) => run(`set role authenticated; select set_config('request.jwt.claim.sub','${id(user)}',false); ${sql}`).split('\n').slice(1).join('\n')
assert.equal(asUser(1, 'select count(*) from checkpoints;'), '1')
assert.equal(asUser(2, 'select count(*) from checkpoints;'), '0')
const restore = (project: number, checkpoint: number, user: number) => `insert into checkpoint_restore_requests(project_id,target_checkpoint_id,requested_by) values('${id(project)}','${id(checkpoint)}','${id(user)}');`
assert.throws(() => asUser(1, restore(11, 41, 1)))

// An in-flight publication holds the row lock; the delayed report must see
// its committed state and leave it published, even at a newer revision.
const publisher = spawn(psql, args, { stdio: ['pipe', 'pipe', 'pipe'] })
const finished = new Promise<void>((resolve, reject) => {
  let stderr = ''
  publisher.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
  publisher.once('error', reject)
  publisher.once('close', (code) => code === 0 ? resolve() : reject(new Error(stderr)))
})
const locked = new Promise<void>((resolve) => publisher.stdout.on('data', (chunk: Buffer) => { if (chunk.toString().includes('LOCKED')) resolve() }))
publisher.stdin.end(`begin; update checkpoints set push_status='publishing' where id='${id(41)}'; update checkpoints set push_status='published',published_sha='${sha}' where id='${id(41)}'; select 'LOCKED'; select pg_sleep(0.3); commit;`)
await locked
assert.equal(report({ revision: 10, validation: 'failed' }), 'ignored')
await finished
assert.equal(run(`select push_status from checkpoints where id='${id(41)}';`), 'published')
asUser(1, restore(11, 41, 1))
assert.throws(() => asUser(2, restore(22, 41, 2)))
run(`update checkpoints set push_status='integrated',integration_status='merged' where id='${id(41)}';`)
assert.equal(report({ revision: 11 }), 'ignored')
assert.equal(run(`select push_status||':'||integration_status from checkpoints where id='${id(41)}';`), 'integrated:merged')
assert.equal(run(`select count(*) from checkpoints where push_status in ('publishing','published','integrated');`), '1')
assert.equal(report({ checkpoint: 45 }), 'recorded')
assert.equal(run(`select count(*) from checkpoints where push_status in ('publishing','published','integrated');`), '1')

// A device clock behind the parent must not let sync ignore the new published
// head, or allow another device to pass the freshness check with the old parent.
const latestKnown = () => run("select id from checkpoints where push_status in ('publishing','published','integrated') order by created_at desc limit 1;")
assert.equal(report({ checkpoint: 46, createdAt: '2000-01-01T00:00:00Z' }), 'recorded')
assert.equal(latestKnown(), id(41))
run(`set role service_role; update checkpoints set push_status='publishing',parent_checkpoint_id='${id(41)}' where id='${id(46)}';`)
assert.equal(latestKnown(), id(46))
const serverOrder = run(`select created_at from checkpoints where id='${id(46)}';`)
assert.notEqual(new Date(serverOrder).getUTCFullYear(), 2000)
// The same checkpoint's publication retry and delayed metadata do not move it.
run(`set role service_role; update checkpoints set push_status='publishing' where id='${id(46)}';`)
assert.equal(report({ checkpoint: 46, revision: 50, createdAt: '1990-01-01T00:00:00Z' }), 'ignored')
assert.equal(run(`select created_at from checkpoints where id='${id(46)}';`), serverOrder)
run(`set role service_role; update checkpoints set push_status='published',published_sha='${sha}' where id='${id(46)}';`)
assert.equal(latestKnown(), id(46))
console.log('✓ PostgreSQL real: metadata idempotente, revisões, dono/device/SHA, revogação, RLS, restore e corrida com publicação; relógio local atrasado não altera a ordem remota.')
