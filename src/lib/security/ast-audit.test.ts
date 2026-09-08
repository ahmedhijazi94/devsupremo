import { afterEach, describe, expect, it } from 'vitest'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function audit(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'supremo-ast-audit-'))
  dirs.push(dir)
  mkdirSync(join(dir, 'scripts'))
  copyFileSync(resolve('scripts/security-audit.js'), join(dir, 'scripts/security-audit.js'))
  symlinkSync(resolve('node_modules'), join(dir, 'node_modules'), 'dir')
  for (const [name, content] of Object.entries({ '.gitignore': '.env*\n', ...files })) {
    mkdirSync(dirname(join(dir, name)), { recursive: true })
    writeFileSync(join(dir, name), content)
  }
  const result = spawnSync(process.execPath, ['scripts/security-audit.js', '--strict', '--json'], { cwd: dir, encoding: 'utf8' })
  expect(result.error).toBeUndefined()
  expect(result.stderr).toBe('')
  const report = JSON.parse(result.stdout) as { findings: Array<{ category: string; severity: string; file: string; code: string }> }
  return { status: result.status, findings: report.findings, category: (name: string) => report.findings.filter(f => f.category === name) }
}
const authenticated = "const { data: { user } } = await client.auth.getUser(); if (!user) throw Error('unauthorized');"
const validate = 'const parsed = schema.parse(input);'

describe('auditor AST executável', () => {
  it('detecta IDOR real com literais preservados e ignora exemplo em comentário/string', () => {
    const result = audit({ 'app/actions.ts': `'use server';
      const example = "client.from('other').delete().eq('id', input)";
      // client.from('comment').delete().eq('id', input)
      export async function remove(input: string) { ${validate} ${authenticated}
        return client.from('tickets').delete().eq('id', parsed); }` })
    expect(result.status).toBe(1)
    expect(result.category('IDOR')).toHaveLength(1)
    expect(result.category('IDOR')[0]?.code).toContain("from('tickets')")
  })
  it('aceita o filtro de dono com sessão e entrada validadas na mesma operação', () => {
    const result = audit({ 'app/actions.ts': `'use server';
      export const remove = async (input: string) => { ${validate} ${authenticated}
        return client.from('tickets').delete().eq('id', parsed).eq('user_id', user.id); };` })
    expect(result.findings).toEqual([])
    expect(result.status).toBe(0)
  })
  it.each([
    "export async function guarded() { await requireUser(); } export const remove = async () => client.from('tickets').delete();",
    "export async function remove() { async function unused() { await requireUser(); } return client.from('tickets').delete(); }",
    "export async function remove() { await client.from('tickets').delete(); await requireUser(); }",
  ])('uma chamada de auth alheia/atrasada não autoriza a entrada: %s', (body) => {
    const result = audit({ 'app/actions.ts': `'use server'; ${body}` })
    expect(result.status).toBe(1)
    expect(result.category('AUTHZ')).toHaveLength(1)
  })
  it('reconhece Server Action inline e exige validar parâmetros antes de persistir', () => {
    const result = audit({ 'app/page.tsx': `export default function Page() {
      async function save(input: string) { 'use server'; ${authenticated}
        await client.from('tickets').update({ title: input }).eq('user_id', user.id); }
      return null;
    }` })
    expect(result.category('SERVER_INPUT')).toHaveLength(1)
    expect(result.status).toBe(1)
  })
  it('segue importação dinâmica desde components/ da raiz até segredo servidor', () => {
    const result = audit({
      'components/feature.tsx': `'use client'; export async function load() { return import('../lib/private') }`,
      'lib/private.ts': 'export const token = process.env.PAYMENT_PRIVATE_KEY;',
    })
    expect(result.category('CLIENT_SERVER_BOUNDARY')).toHaveLength(1)
    expect(result.status).toBe(1)
  })
  it('permite RPC de Server Action, mas bloqueia mutação direta no client', () => {
    const result = audit({ 'components/feature.tsx': `'use client';
      export async function save() { return client.from('tickets').insert({ title: 'new' }); }` })
    expect(result.category('CLIENT_MUTATION')).toHaveLength(1)
  })
  it('mutação em helper importado também pertence à fronteira cliente', () => {
    const result = audit({
      'components/feature.tsx': "'use client'; import { save } from '../lib/mutation'; export const submit = save;",
      'lib/mutation.ts': "export const save = () => client.from('tickets').insert({ title: 'new' });",
    })
    expect(result.category('CLIENT_MUTATION')).toHaveLength(1)
    expect(result.status).toBe(1)
  })
  it('upsert de outra linha não é autorizado apenas por escrever user_id no payload', () => {
    const result = audit({ 'app/actions.ts': `'use server'; export async function save() { ${authenticated}
      return client.from('tickets').upsert({ id: 'foreign-row', user_id: user.id }, { onConflict: 'id' }); }` })
    expect(result.category('IDOR')).toHaveLength(1)
    expect(result.status).toBe(1)
  })
})

describe('contratos de schema verificáveis', () => {
  const schema = `CREATE TABLE tickets (id uuid PRIMARY KEY, user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE);
    ALTER TABLE tickets ENABLE ROW LEVEL SECURITY;`
  it('exige índice e comportamento explícito de exclusão para FK', () => {
    const result = audit({ 'supabase/migrations/001.sql': schema.replace(' ON DELETE CASCADE', '') })
    expect(result.category('SQL_CONTRACT')).toHaveLength(1)
    expect(result.category('SQL_INDEX')).toHaveLength(1)
    expect(result.status).toBe(1)
  })
  it('aceita migration posterior com índice completo e não confunde coluna errada/índice parcial', () => {
    const result = audit({
      'supabase/migrations/001.sql': schema,
      'supabase/migrations/002.sql': 'CREATE INDEX ix ON tickets(user_id, id);',
    })
    expect(result.findings).toEqual([])
    expect(result.status).toBe(0)
    const partial = audit({ 'supabase/migrations/001.sql': schema + ' CREATE INDEX ix ON tickets(user_id) WHERE user_id IS NOT NULL;' })
    expect(partial.category('SQL_INDEX')).toHaveLength(1)
  })
  it('recusa índice removido e RLS desativado em migration posterior', () => {
    const result = audit({
      'supabase/migrations/001.sql': schema + ' CREATE INDEX ix ON tickets(user_id);',
      'supabase/migrations/002.sql': 'DROP INDEX ix; ALTER TABLE tickets DISABLE ROW LEVEL SECURITY;',
    })
    expect(result.category('SQL_INDEX')).toHaveLength(1)
    expect(result.category('SQL_CONTRACT')).toHaveLength(1)
  })
  it('RLS precisa de DDL real na tabela exata e pode ser ativado por migration posterior', () => {
    const missing = audit({ 'supabase/migrations/001.sql': 'CREATE TABLE "Tickets" (id uuid); ALTER TABLE tickets ENABLE ROW LEVEL SECURITY;' })
    expect(missing.category('SQL_CONTRACT')).toHaveLength(1)
    const comments = audit({ 'supabase/migrations/001.sql': 'CREATE TABLE tickets (id uuid); -- ALTER TABLE tickets ENABLE ROW LEVEL SECURITY;' })
    expect(comments.category('SQL_CONTRACT')).toHaveLength(1)
    const forward = audit({
      'supabase/migrations/001.sql': 'CREATE TABLE tickets (id uuid);',
      'supabase/migrations/002.sql': 'ALTER TABLE tickets ENABLE ROW LEVEL SECURITY;',
    })
    expect(forward.category('SQL_CONTRACT')).toHaveLength(0)
  })
  it('ALTER com múltiplas cláusulas não esconde a desativação de RLS', () => {
    const result = audit({ 'supabase/migrations/001.sql': 'CREATE TABLE tickets (id uuid); ALTER TABLE tickets ENABLE ROW LEVEL SECURITY; ALTER TABLE tickets DISABLE ROW LEVEL SECURITY, ADD COLUMN title text;' })
    expect(result.category('SQL_CONTRACT')).toHaveLength(1)
    expect(result.status).toBe(1)
  })
  it('comentário e corpo de função não suprem índice de FK', () => {
    const result = audit({ 'supabase/migrations/001.sql': schema + `
      /* CREATE INDEX ix ON tickets(user_id); */
      CREATE FUNCTION example() RETURNS void LANGUAGE plpgsql AS $$ BEGIN RAISE NOTICE 'CREATE INDEX ix ON tickets(user_id);'; END $$;` })
    expect(result.category('SQL_INDEX')).toHaveLength(1)
  })
})
