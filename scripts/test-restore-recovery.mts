/** Real disposable PostgreSQL, including two concurrent claimants and lost ACK. */
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
await import('./test-checkpoint-report.mts')
const target = process.env.SUPREMO_TEST_DATABASE_URL!
const psql = process.env.SUPREMO_TEST_PSQL ?? 'psql'
const args = [target, '-XqAt', '-v', 'ON_ERROR_STOP=1']
const run = (sql: string) => execFileSync(psql, args, { input: sql, encoding: 'utf8', stdio: ['pipe','pipe','pipe'] }).trim()
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const sha = 'c'.repeat(40)
run(readFileSync(new URL('../supabase/migrations/022_restore_recovery.sql', import.meta.url), 'utf8'))
run(readFileSync(new URL('../supabase/migrations/023_engine_foreign_key_indexes.sql', import.meta.url), 'utf8'))
assert.equal(run("select count(*) from pg_indexes where schemaname='public' and indexname in ('idx_oauth_states_project_id','idx_secret_requests_user_id','idx_project_runtimes_user_id','idx_validation_runs_user_id','idx_agent_sessions_user_id','idx_checkpoints_device_id','idx_restore_requested_by','idx_restore_result_checkpoint_id');"),'8')
run(`delete from checkpoint_restore_requests; insert into checkpoint_devices(id,owner_user_id,secret_hash)
  values('${id(33)}','${id(1)}','same-owner-other-device');
  insert into checkpoint_restore_requests(id,project_id,target_checkpoint_id,requested_by)
  values('${id(101)}','${id(11)}','${id(41)}','${id(1)}');`)
const claim = (device = 31, project = 11) => `select id from claim_checkpoint_restore('${id(project)}','${id(device)}');`
assert.equal(run(`set role service_role; ${claim(32)}`), '')
assert.equal(run(`set role service_role; ${claim(33)}`), '') // original workstation affinity
// A transaction owns the project row; concurrent poll cannot also get a lease.
const first = spawn(psql,args,{stdio:['pipe','pipe','pipe']})
const finished = new Promise<void>((resolve,reject) => { let stderr=''; first.stderr.on('data',(chunk: Buffer)=>{stderr+=chunk.toString()}); first.once('error',reject); first.once('close',(code)=>code===0?resolve():reject(new Error(stderr))) })
const locked = new Promise<void>((resolve)=>first.stdout.on('data',(chunk: Buffer)=>{if(chunk.toString().includes('CLAIMED'))resolve()}))
first.stdin.end(`begin; set role service_role; ${claim()} select 'CLAIMED'; select pg_sleep(0.3); commit;`)
await locked
assert.equal(run(`set role service_role; ${claim()}`),'')
await finished
const token = run(`select claim_token from checkpoint_restore_requests where id='${id(101)}';`)
assert.match(token,/^[a-f0-9-]{36}$/)
// Lost poll/crashed process: expiry redelivers the same idempotency key.
run(`update checkpoint_restore_requests set lease_expires_at=now()-interval '1 second' where id='${id(101)}';`)
assert.equal(run(`set role service_role; ${claim()}`),id(101))
assert.equal(run(`select claim_token from checkpoint_restore_requests where id='${id(101)}';`),token)
const finish = (over: { device?: number; project?: number; token?: string; result?: number; sha?: string; status?: string; error?: string | null } = {}) => `select finish_checkpoint_restore('${id(101)}','${id(over.project??11)}','${id(over.device??31)}','${over.token??token}', '${over.status??'applied'}','${id(over.result??102)}','${over.sha??sha}',${over.error ? "'"+over.error+"'" : 'NULL'});`
assert.equal(run(`set role service_role; ${finish({device:33})}`),'conflict')
assert.equal(run(`set role service_role; ${finish({project:22})}`),'conflict')
assert.equal(run(`set role service_role; ${finish({token:id(99)})}`),'conflict')
assert.equal(run(`select count(*) from checkpoints where id='${id(102)}';`),'0')
// E does not exist remotely. ACK atomically registers local metadata before FK.
assert.equal(run(`set role service_role; ${finish()}`),'acknowledged')
assert.equal(run(`select status||':'||result_checkpoint_id::text||':'||result_commit_sha from checkpoint_restore_requests where id='${id(101)}';`),`applied:${id(102)}:${sha}`)
assert.equal(run(`select push_status||':'||local_validation_status||':'||restored_from_checkpoint_id::text from checkpoints where id='${id(102)}';`),`local:pending:${id(41)}`)
assert.equal(run(`set role service_role; ${finish()}`),'acknowledged') // network lost the previous response
assert.equal(run(`set role service_role; ${finish({sha:'d'.repeat(40)})}`),'conflict')
assert.equal(run(`set role service_role; ${finish({result:103})}`),'conflict')
run(`update checkpoint_devices set revoked_at=now() where id='${id(31)}';`)
assert.equal(run(`set role service_role; ${finish()}`),'conflict')
run(`update checkpoint_devices set revoked_at=null where id='${id(31)}';`)
for(const role of ['anon','authenticated']) {
  assert.throws(()=>run(`set role ${role}; ${claim()}`))
  assert.throws(()=>run(`set role ${role}; ${finish()}`))
}
// RLS rejects user-forged terminal status or claim metadata.
assert.throws(()=>run(`set role authenticated; select set_config('request.jwt.claim.sub','${id(1)}',false);
 insert into checkpoint_restore_requests(project_id,target_checkpoint_id,requested_by,status)
 values('${id(11)}','${id(41)}','${id(1)}','applied');`))
// Old pre-upgrade claimed requests have no lease and are recovered too.
run(`insert into checkpoint_restore_requests(id,project_id,target_checkpoint_id,requested_by,status,device_id)
 values('${id(104)}','${id(11)}','${id(41)}','${id(1)}','claimed','${id(31)}');`)
assert.equal(run(`set role service_role; ${claim()}`),id(104))
console.log('✓ PostgreSQL real: histórico001–023 + oito índices; restore lease concorrente, expiração/legado, afinidade device, owner/claim/SHA/revogação, metadata antes do FK, ACK idempotente e RLS de campos privados.')
