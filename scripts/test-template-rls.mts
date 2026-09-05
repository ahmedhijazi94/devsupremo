/** Testa o SQL REAL gerado em Postgres descartável, sem Supabase/contas remotas. */
import { execFileSync } from 'node:child_process'
import { buildProjectFiles } from '../src/lib/templates/project-files'

const target = process.env.SUPREMO_TEST_DATABASE_URL
if (!target || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(target).hostname)) {
  throw new Error('SUPREMO_TEST_DATABASE_URL deve apontar para um Postgres local descartável.')
}
const files = buildProjectFiles({ projectName: 'rls-test', description: '', kind: 'team' })
const initial = files.find((file) => file.path.endsWith('00000000000000_initial_schema.sql'))!.content
const upgrade = files.find((file) => file.path.endsWith('_membership_authorization.sql'))!.content

const bootstrap = `
BEGIN;
CREATE SCHEMA auth;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE anon NOLOGIN;
CREATE TABLE auth.users (id uuid PRIMARY KEY);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
${initial}
GRANT USAGE ON SCHEMA public, auth TO authenticated, anon;
GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated, anon;
INSERT INTO auth.users VALUES ('00000000-0000-0000-0000-000000000001'), ('00000000-0000-0000-0000-000000000002');
INSERT INTO orgs (id,name) VALUES ('10000000-0000-0000-0000-000000000001','A'), ('10000000-0000-0000-0000-000000000002','B');
INSERT INTO memberships (org_id,user_id) VALUES
 ('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001'),
 ('10000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000002');
INSERT INTO projects (org_id,name) VALUES ('10000000-0000-0000-0000-000000000001','privado');
`
const assertions = `
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',true);
DO $$ BEGIN
 IF (SELECT count(*) FROM projects) <> 1 THEN RAISE EXCEPTION 'Dono perdeu acesso'; END IF;
END $$;
SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002',true);
DO $$ DECLARE n integer; BEGIN
 IF (SELECT count(*) FROM projects) <> 0 THEN RAISE EXCEPTION 'Vazamento cross-tenant'; END IF;
 UPDATE projects SET name='ataque'; GET DIAGNOSTICS n = ROW_COUNT;
 IF n <> 0 THEN RAISE EXCEPTION 'UPDATE cross-tenant'; END IF;
 DELETE FROM projects; GET DIAGNOSTICS n = ROW_COUNT;
 IF n <> 0 THEN RAISE EXCEPTION 'DELETE cross-tenant'; END IF;
 BEGIN
   INSERT INTO memberships (org_id,user_id,role) VALUES
    ('10000000-0000-0000-0000-000000000001',auth.uid(),'owner');
   RAISE EXCEPTION 'Adesão indevida aceita';
 EXCEPTION WHEN insufficient_privilege THEN NULL;
 END;
END $$;
SET LOCAL ROLE anon;
SELECT set_config('request.jwt.claim.sub','',true);
DO $$ BEGIN
 IF (SELECT count(*) FROM projects) <> 0 THEN RAISE EXCEPTION 'Vazamento anon'; END IF;
END $$;
ROLLBACK;
`

function run(sql: string): void {
  execFileSync('psql', [target!, '-X', '-v', 'ON_ERROR_STOP=1'], {
    input: sql, stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8',
  })
}

run(bootstrap + assertions)
console.log('✓ Template team: dono acessa; outro tenant e anon não acessam; adesão indevida bloqueada.')
const vulnerablePolicy = 'CREATE POLICY "memberships_insert_own" ON memberships FOR INSERT WITH CHECK (user_id = auth.uid());'
// Prova que o teste detecta a falha antiga, não apenas um erro de preparação.
try {
  run(bootstrap + vulnerablePolicy + assertions)
  throw new Error('O teste não detectou o baseline vulnerável.')
} catch (error) {
  const stderr = error && typeof error === 'object' && 'stderr' in error ? String(error.stderr) : ''
  if (!stderr.includes('Adesão indevida aceita')) throw error
}
run(bootstrap + vulnerablePolicy + upgrade + assertions)
console.log('✓ Upgrade forward-only corrige o baseline antigo e preserva acesso legítimo.')
