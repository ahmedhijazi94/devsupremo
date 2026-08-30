import { describe, expect, it } from 'vitest'
import { assertSafeSql, UnsafeSqlError } from './sql-guard'

const readOnly = { allowDdl: false }
const migration = { allowDdl: true }

describe('assertSafeSql — leitura (execute_sql)', () => {
  it('permite SELECT', () => {
    expect(() =>
      assertSafeSql('SELECT id, name FROM posts LIMIT 10', readOnly),
    ).not.toThrow()
  })

  it('permite CTE e agregação', () => {
    expect(() =>
      assertSafeSql(
        'WITH recent AS (SELECT * FROM posts) SELECT count(*) FROM recent',
        readOnly,
      ),
    ).not.toThrow()
  })

  it('recusa DDL', () => {
    expect(() => assertSafeSql('CREATE TABLE x (id int)', readOnly)).toThrow(
      UnsafeSqlError,
    )
  })

  it('recusa escrita de dados', () => {
    expect(() =>
      assertSafeSql("INSERT INTO posts (title) VALUES ('x')", readOnly),
    ).toThrow(UnsafeSqlError)
    expect(() => assertSafeSql('DELETE FROM posts', readOnly)).toThrow(
      UnsafeSqlError,
    )
  })

  it('recusa DDL escondido depois de um SELECT', () => {
    expect(() =>
      assertSafeSql('SELECT 1; DROP TABLE posts;', readOnly),
    ).toThrow(UnsafeSqlError)
  })

  it('recusa query vazia', () => {
    expect(() => assertSafeSql('   ', readOnly)).toThrow(UnsafeSqlError)
  })
})

describe('assertSafeSql — proibições absolutas', () => {
  const cases: Array<[string, string]> = [
    ['DROP DATABASE postgres', 'drop database'],
    ['DROP SCHEMA public CASCADE', 'drop schema public'],
    ['ALTER TABLE posts DISABLE ROW LEVEL SECURITY', 'desligar RLS'],
    ['GRANT ALL ON posts TO anon', 'grant para anon'],
    ['CREATE POLICY "p" ON posts FOR ALL USING (true)', 'policy USING (true)'],
    [
      'CREATE POLICY "p" ON posts FOR INSERT WITH CHECK (true)',
      'insert WITH CHECK (true)',
    ],
  ]

  it.each(cases)('recusa %s', (sql) => {
    expect(() => assertSafeSql(sql, migration)).toThrow(UnsafeSqlError)
  })

  it('recusa mesmo em modo migration', () => {
    expect(() =>
      assertSafeSql('ALTER TABLE auth.users ADD COLUMN x int', migration),
    ).toThrow(UnsafeSqlError)
  })
})

describe('assertSafeSql — RLS obrigatório em tabela nova', () => {
  it('recusa CREATE TABLE sem ENABLE ROW LEVEL SECURITY', () => {
    expect(() =>
      assertSafeSql('CREATE TABLE posts (id uuid PRIMARY KEY)', migration),
    ).toThrow(/sem RLS/i)
  })

  it('aceita quando o RLS vem junto', () => {
    const sql = `
      CREATE TABLE posts (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL
      );
      ALTER TABLE posts ENABLE ROW LEVEL SECURITY;
      CREATE POLICY "posts_owner_only" ON posts FOR ALL USING (auth.uid() = user_id);
    `
    expect(() => assertSafeSql(sql, migration)).not.toThrow()
  })

  it('cobre IF NOT EXISTS e nome com schema', () => {
    const sql = `
      CREATE TABLE IF NOT EXISTS public.comments (id uuid PRIMARY KEY);
      ALTER TABLE public.comments ENABLE ROW LEVEL SECURITY;
      CREATE POLICY "c" ON comments FOR ALL USING (auth.uid() = user_id);
    `
    expect(() => assertSafeSql(sql, migration)).not.toThrow()
  })

  it('aponta todas as tabelas sem RLS de uma vez', () => {
    const sql = `
      CREATE TABLE a (id int);
      CREATE TABLE b (id int);
      ALTER TABLE a ENABLE ROW LEVEL SECURITY;
    `
    expect(() => assertSafeSql(sql, migration)).toThrow(/\bb\b/)
  })

  it('não exige RLS fora do schema public', () => {
    expect(() =>
      assertSafeSql('CREATE TABLE internal.cache (id int)', migration),
    ).not.toThrow()
  })
})

describe('assertSafeSql — normalização', () => {
  it('não se confunde com a palavra proibida dentro de string', () => {
    expect(() =>
      assertSafeSql(
        "SELECT * FROM posts WHERE body = 'drop database'",
        readOnly,
      ),
    ).not.toThrow()
  })

  it('não se confunde com comentário', () => {
    expect(() =>
      assertSafeSql('SELECT 1 -- DROP DATABASE postgres', readOnly),
    ).not.toThrow()
  })

  it('enxerga DDL depois de comentário de bloco', () => {
    expect(() =>
      assertSafeSql('/* nota */ CREATE TABLE x (id int)', readOnly),
    ).toThrow(UnsafeSqlError)
  })
})
