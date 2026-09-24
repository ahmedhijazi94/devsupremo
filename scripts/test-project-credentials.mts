/** Run after test-secret-requests in its disposable local PostgreSQL cluster. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { decryptCredential, encryptCredential } from '../src/lib/credentials/crypto'

const target = process.env.SUPREMO_TEST_DATABASE_URL
if (!target || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(target).hostname)) {
  throw new Error('Use o PostgreSQL local descartável dos testes de migrations.')
}
const run = (sql: string): string => execFileSync(process.env.SUPREMO_TEST_PSQL ?? 'psql', [target, '-XqAt', '-v', 'ON_ERROR_STOP=1'], {
  input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
}).trim()
const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`
const backend = (sql: string): string => run(`SET ROLE service_role; ${sql}`)
const user = (n: number, sql: string): string => run(`SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub','${id(n)}',false); ${sql}`).split('\n').slice(1).join('\n')

// Require known test fixtures. Never reset an application schema or reuse its values.
assert.equal(run(`SELECT count(*) FROM projects WHERE id IN ('${id(11)}','${id(22)}') AND name IN ('Scratch A','Scratch B');`), '2')
assert.equal(run("SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='secret_requests' AND column_name='configuration';"), '1')
assert.equal(run("SELECT to_regclass('public.project_credentials') IS NULL;"), 't')
run(readFileSync(new URL('../supabase/migrations/026_project_credentials.sql', import.meta.url), 'utf8'))

const originalKey = process.env.ENCRYPTION_KEY
process.env.ENCRYPTION_KEY = 'ab'.repeat(32)
try {
  const context = { id: id(601), userId: id(1), projectId: id(11), environment: 'development' as const }
  const value = '{"key":"synthetic-test-value","multiline":"line1\\nline2"}'
  const encrypted = encryptCredential(value, context)
  const insert = (row = 601, name = 'RESEND_API_KEY', environment = 'development', ciphertext = encrypted, project = 11, owner = 1): string =>
    `INSERT INTO project_credentials(id,user_id,project_id,name,environment,encrypted_value,updated_at) VALUES ('${id(row)}','${id(owner)}','${id(project)}',${quote(name)},${quote(environment)},${quote(ciphertext)},'2000-01-01');`
  backend(insert())
  backend(insert(602, 'AUTH_SMTP_PASSWORD', 'production'))
  backend(insert(603, 'PAYMENTS_KEY', 'preview', encrypted, 22, 2))
  const stored = backend(`SELECT encrypted_value FROM project_credentials WHERE id='${id(601)}';`)
  assert.equal(decryptCredential(stored, context), value)
  assert.ok(!stored.includes('synthetic-test-value'))
  assert.equal(backend(`SELECT created_at IS NOT NULL FROM project_credentials WHERE id='${id(601)}';`), 't')

  for (const actor of [1, 2]) {
    for (const query of [
      'SELECT * FROM project_credentials;',
      'SELECT id,name,environment FROM project_credentials;',
      insert(604),
      `UPDATE project_credentials SET encrypted_value=${quote(encrypted)} WHERE id='${id(601)}';`,
      `DELETE FROM project_credentials WHERE id='${id(601)}';`,
      'TRUNCATE project_credentials;',
    ]) assert.throws(() => user(actor, query), /permission denied/)
  }
  for (const query of ['SELECT encrypted_value FROM project_credentials;', insert(604), 'DELETE FROM project_credentials;', 'TRUNCATE project_credentials;']) {
    assert.throws(() => run(`SET ROLE anon; ${query}`), /permission denied/)
  }
  // RLS remains a second barrier if a future migration accidentally restores grants.
  assert.equal(run(`BEGIN; GRANT SELECT ON project_credentials TO authenticated; SET LOCAL ROLE authenticated; SELECT count(*) FROM project_credentials; ROLLBACK;`), '0')
  assert.equal(run("SELECT relrowsecurity FROM pg_class WHERE oid='public.project_credentials'::regclass;"), 't')
  assert.equal(run("SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='project_credentials';"), '0')
  assert.equal(run("SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='project_credentials' AND column_name IN ('value','secret_value','token','password','key');"), '0')

  for (const name of ['api_key', '1KEY', 'A'.repeat(129), 'NEXT_PUBLIC_KEY', 'PUBLIC_KEY', 'VITE_KEY', 'REACT_APP_KEY', 'NUXT_PUBLIC_KEY', 'AUTH_USER_PASSWORD_TEST', 'NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'PATH', 'HOME', 'SHELL']) {
    assert.throws(() => backend(insert(604, name)), /check constraint/)
  }
  assert.throws(() => backend(insert(604, 'RESEND_API_KEY', 'unscoped')), /check constraint/)
  for (const ciphertext of ['', value, encrypted.replace('v1:', 'v2:'), `${encrypted}a`, `${encrypted}\n`, `${encrypted.slice(0, 61)}${'aa'.repeat(16_385)}`]) {
    assert.throws(() => backend(insert(604, 'API_KEY', 'development', ciphertext)), /check constraint/)
  }
  assert.throws(() => backend(insert(601)), /duplicate key/)
  assert.throws(() => backend(insert(604, 'API_KEY', 'development', encrypted, 999)), /foreign key constraint/)
  assert.throws(() => backend(insert(604, 'API_KEY', 'development', encrypted, 11, 999)), /foreign key constraint/)
  backend(`UPDATE project_credentials SET name='MAIL_API_KEY' WHERE id='${id(601)}';`)
  assert.equal(backend(`SELECT updated_at > '2000-01-01'::timestamptz FROM project_credentials WHERE id='${id(601)}';`), 't')
  assert.equal(run("SELECT count(*) FROM pg_indexes WHERE schemaname='public' AND tablename='project_credentials' AND indexname IN ('idx_project_credentials_user_id','idx_project_credentials_project_id','idx_project_credentials_scope');"), '3')
  assert.equal(backend(`DELETE FROM project_credentials WHERE id='${id(603)}' RETURNING id;`), id(603))

  // Cascades operate only on dedicated fixtures created here.
  run(`INSERT INTO projects(id,user_id,name) VALUES ('${id(611)}','${id(1)}','Credential cascade fixture');`)
  backend(insert(612, 'CASCADE_KEY', 'development', encrypted, 611))
  run(`DELETE FROM projects WHERE id='${id(611)}';`)
  assert.equal(backend(`SELECT count(*) FROM project_credentials WHERE id='${id(612)}';`), '0')
  run(`INSERT INTO auth.users(id) VALUES ('${id(613)}');`)
  backend(insert(614, 'CASCADE_USER_KEY', 'development', encrypted, 11, 613))
  run(`DELETE FROM auth.users WHERE id='${id(613)}';`)
  assert.equal(backend(`SELECT count(*) FROM project_credentials WHERE id='${id(614)}';`), '0')
} finally {
  if (originalKey === undefined) delete process.env.ENCRYPTION_KEY
  else process.env.ENCRYPTION_KEY = originalKey
}
console.log('✓ PostgreSQL real: migration026 mantém criptografia contextual; nenhum acesso de browser ao cofre; RLS sem políticas; nomes/ambientes/envelopes privados; índices, timestamps e cascatas verificados.')
