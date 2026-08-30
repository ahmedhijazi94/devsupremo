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

/**
 * Cada teste abaixo tem o nome de um furo real, encontrado atacando a versão
 * anterior do guard em vez de ler os regex dela. Todos passavam.
 *
 * Não os agrupe nem os reescreva de forma genérica: o valor está em falhar
 * com o nome da técnica, para que a regressão se identifique sozinha.
 */
describe('assertSafeSql — furos encontrados atacando o guard', () => {
  describe('policy que libera a tabela, escrita de outra forma', () => {
    it('recusa USING (1=1) — mesma coisa que USING (true)', () => {
      expect(() =>
        assertSafeSql(
          'CREATE POLICY p ON posts FOR SELECT USING (1=1);',
          migration,
        ),
      ).toThrow(/sempre verdadeira/)
    })

    it('recusa tautologia como operando de OR', () => {
      expect(() =>
        assertSafeSql(
          'CREATE POLICY p ON posts FOR SELECT USING (auth.uid() = user_id OR true);',
          migration,
        ),
      ).toThrow(/sempre verdadeira/)
    })

    it('recusa WITH CHECK (true) em FOR ALL, que inclui INSERT', () => {
      expect(() =>
        assertSafeSql(
          'CREATE POLICY p ON posts FOR ALL USING (auth.uid() = user_id) WITH CHECK (true);',
          migration,
        ),
      ).toThrow(/sempre verdadeira/)
    })

    it('recusa WITH CHECK (true) em FOR UPDATE', () => {
      expect(() =>
        assertSafeSql(
          'CREATE POLICY p ON posts FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (true);',
          migration,
        ),
      ).toThrow(/sempre verdadeira/)
    })

    it('recusa policy de escrita que não chega em auth.uid()', () => {
      expect(() =>
        assertSafeSql(
          'CREATE POLICY p ON posts FOR INSERT WITH CHECK (status = 1);',
          migration,
        ),
      ).toThrow(/não referencia auth\.uid/)
    })

    it('vale também para ALTER POLICY', () => {
      expect(() =>
        assertSafeSql('ALTER POLICY p ON posts USING (1 = 1);', migration),
      ).toThrow(/sempre verdadeira/)
    })
  })

  describe('privilégio que passa por cima do RLS', () => {
    it('recusa função SECURITY DEFINER', () => {
      expect(() =>
        assertSafeSql(
          `CREATE FUNCTION vazar() RETURNS SETOF profiles LANGUAGE sql
             SECURITY DEFINER AS $$ SELECT * FROM profiles $$;`,
          migration,
        ),
      ).toThrow(/SECURITY DEFINER/)
    })

    it('recusa NO FORCE ROW LEVEL SECURITY', () => {
      expect(() =>
        assertSafeSql(
          'ALTER TABLE posts NO FORCE ROW LEVEL SECURITY;',
          migration,
        ),
      ).toThrow(UnsafeSqlError)
    })
  })

  describe('corpo de função não é mais uma zona cega', () => {
    it('recusa DISABLE RLS escondido em EXECUTE dentro do corpo', () => {
      expect(() =>
        assertSafeSql(
          `CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $$
             BEGIN EXECUTE 'ALTER TABLE profiles DISABLE ROW LEVEL SECURITY'; END
           $$;`,
          migration,
        ),
      ).toThrow(/corpo de uma função/)
    })

    it('recusa GRANT a anon escondido no corpo', () => {
      expect(() =>
        assertSafeSql(
          `CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $body$
             BEGIN EXECUTE 'GRANT ALL ON profiles TO anon'; END
           $body$;`,
          migration,
        ),
      ).toThrow(/corpo de uma função/)
    })

    it('aceita função comum, com corpo inofensivo', () => {
      expect(() =>
        assertSafeSql(
          `CREATE FUNCTION public.set_updated_at() RETURNS TRIGGER
             LANGUAGE plpgsql SET search_path = '' AS $$
             BEGIN NEW.updated_at = NOW(); RETURN NEW; END
           $$;`,
          migration,
        ),
      ).not.toThrow()
    })
  })

  describe('escrita escondida em CTE — execute_sql é só leitura', () => {
    it('recusa DELETE dentro de CTE', () => {
      expect(() =>
        assertSafeSql(
          'WITH d AS (DELETE FROM profiles RETURNING id) SELECT count(*) FROM d;',
          readOnly,
        ),
      ).toThrow(/DELETE/)
    })

    it('recusa INSERT dentro de CTE', () => {
      expect(() =>
        assertSafeSql(
          "WITH n AS (INSERT INTO posts (title) VALUES ('x') RETURNING id) SELECT * FROM n;",
          readOnly,
        ),
      ).toThrow(/INSERT/)
    })

    it('recusa UPDATE dentro de CTE', () => {
      expect(() =>
        assertSafeSql(
          "WITH u AS (UPDATE posts SET title = 'z' RETURNING id) SELECT * FROM u;",
          readOnly,
        ),
      ).toThrow(/UPDATE/)
    })

    it('recusa controle de transação, que desfaria o READ ONLY', () => {
      expect(() =>
        assertSafeSql('COMMIT; DELETE FROM posts;', readOnly),
      ).toThrow(UnsafeSqlError)
      expect(() =>
        assertSafeSql('SET default_transaction_read_only = off;', readOnly),
      ).toThrow(UnsafeSqlError)
    })

    it('não confunde nome de coluna com verbo de escrita', () => {
      expect(() =>
        assertSafeSql(
          'SELECT id, deleted_at, updated_at FROM posts WHERE deleted_at IS NULL',
          readOnly,
        ),
      ).not.toThrow()
    })

    it('não confunde literal com comando', () => {
      expect(() =>
        assertSafeSql(
          "SELECT * FROM audit_logs WHERE action = 'delete from posts'",
          readOnly,
        ),
      ).not.toThrow()
    })
  })

  describe('o que deve continuar passando', () => {
    it('aceita policy de dono', () => {
      expect(() =>
        assertSafeSql(
          `CREATE TABLE posts (id uuid primary key, user_id uuid not null);
           ALTER TABLE posts ENABLE ROW LEVEL SECURITY;
           CREATE POLICY posts_own ON posts FOR ALL
             USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);`,
          migration,
        ),
      ).not.toThrow()
    })

    it('aceita leitura pública por predicado de coluna, que é uma decisão', () => {
      expect(() =>
        assertSafeSql(
          'CREATE POLICY posts_public ON posts FOR SELECT USING (published = true);',
          migration,
        ),
      ).not.toThrow()
    })

    it('aceita dono via subconsulta até auth.uid()', () => {
      expect(() =>
        assertSafeSql(
          `CREATE POLICY m ON documents FOR ALL USING (
             EXISTS (SELECT 1 FROM members WHERE members.org_id = documents.org_id
                     AND members.user_id = auth.uid())
           ) WITH CHECK (
             EXISTS (SELECT 1 FROM members WHERE members.org_id = documents.org_id
                     AND members.user_id = auth.uid())
           );`,
          migration,
        ),
      ).not.toThrow()
    })
  })
})
