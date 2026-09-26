import { describe, expect, it } from 'vitest'
import { assertExplicitForeignKeyDelete, tokenizeForeignKeySql } from './foreign-key-contract'

describe('foreign key contract before database writes', () => {
  it.each([
    'ALTER TABLE public.orgs ADD COLUMN owner_id uuid REFERENCES auth.users(id);',
    'CREATE TABLE public.team_invitations (id uuid PRIMARY KEY, org_id uuid REFERENCES public.orgs(id) ON DELETE CASCADE, created_by uuid NOT NULL REFERENCES auth.users(id));',
    'CREATE TABLE IF NOT EXISTS public.notes (id uuid, CONSTRAINT fk_owner FOREIGN KEY(id) REFERENCES auth.users(id));',
    'ALTER TABLE ONLY public.notes ADD CONSTRAINT fk_owner FOREIGN KEY(id) REFERENCES auth.users(id);',
    'CREATE TABLE notes (id uuid REFERENCES auth.users(id), second uuid REFERENCES auth.users(id) ON DELETE CASCADE);',
    'ALTER TABLE notes ADD id uuid REFERENCES auth.users(id), ADD second uuid REFERENCES auth.users(id) ON DELETE CASCADE;',
    'CREATE TABLE notes (id uuid REFERENCES auth.users(id) REFERENCES auth.users(id) ON DELETE CASCADE);',
    'CREATE TABLE notes (id uuid REFERENCES auth.users(id)); CREATE TABLE second (id uuid REFERENCES auth.users(id) ON DELETE CASCADE);',
  ])('rejects an omitted clause in %s', (sql) => {
    expect(() => assertExplicitForeignKeyDelete(sql)).toThrow(/ON DELETE.*antes da aplicação/)
  })

  it.each(['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL', 'SET DEFAULT'])('accepts the explicit supported behavior %s', (action) => {
    expect(() => assertExplicitForeignKeyDelete(`CREATE TABLE IF NOT EXISTS public.notes (
      org_id uuid, user_id uuid,
      CONSTRAINT fk_pair FOREIGN KEY(org_id, user_id) REFERENCES public.memberships(org_id, user_id) ON DELETE ${action}
    );`)).not.toThrow()
    expect(() => assertExplicitForeignKeyDelete(`ALTER TABLE "public"."notes" ADD COLUMN "UserId" uuid
      REFERENCES "auth"."users"("id") MATCH SIMPLE ON UPDATE CASCADE ON DELETE ${action} NOT DEFERRABLE;`)).not.toThrow()
  })

  it('allows multiple references only when each has an explicit behavior', () => {
    expect(() => assertExplicitForeignKeyDelete(`CREATE TABLE notes (
      id uuid REFERENCES auth.users(id) ON DELETE NO ACTION,
      second uuid REFERENCES auth.users(id) ON DELETE SET NULL
    ); ALTER TABLE notes ADD third uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
      ADD fourth uuid REFERENCES auth.users(id) ON DELETE CASCADE;`)).not.toThrow()
  })

  it.each([
    " DEFAULT 'ON DELETE CASCADE'",
    ' /* ON DELETE CASCADE */',
    ' /* outer /* inner */ ON DELETE CASCADE */',
    ' -- ON DELETE CASCADE\n',
    ' DEFAULT $literal$ON DELETE CASCADE$literal$',
    ' CONSTRAINT "ON DELETE CASCADE" UNIQUE',
    " CHECK (label = 'ON DELETE CASCADE')",
    ' CHECK ("on" = "delete")',
    ' ON UPDATE CASCADE',
    ' ON DELETE "cascade"',
    " DEFAULT E'\\\' ON DELETE CASCADE'",
  ])('does not accept keyword text or another operation as an explicit delete action: %s', (suffix) => {
    expect(() => assertExplicitForeignKeyDelete(`CREATE TABLE notes (id uuid REFERENCES auth.users(id)${suffix});`)).toThrow(/foreign key nova/)
  })

  it('keeps function bodies, comments, identifiers and other SQL outside the FK declaration check', () => {
    expect(() => assertExplicitForeignKeyDelete(`
      /* CREATE TABLE forged (id uuid REFERENCES auth.users(id)); */
      CREATE FUNCTION public.label() RETURNS text LANGUAGE sql AS $body$
        SELECT 'CREATE TABLE notes (id uuid REFERENCES auth.users(id));'
      $body$;
      COMMENT ON TABLE notes IS 'REFERENCES auth.users(id)';
      GRANT REFERENCES ON TABLE notes TO authenticated;
      CREATE TABLE notes ("references" text DEFAULT 'REFERENCES auth.users(id)', label text);
    `)).not.toThrow()
  })

  it.each(['TEMP', 'TEMPORARY', 'UNLOGGED'])('also checks nonstandard table prefix %s without authorizing its use', (modifier) => {
    expect(() => assertExplicitForeignKeyDelete(`CREATE ${modifier} TABLE notes (id uuid REFERENCES auth.users(id));`)).toThrow(/foreign key nova/)
  })

  it.each([
    "CREATE TABLE notes (label text DEFAULT 'unclosed);",
    'CREATE TABLE "notes (id uuid);',
    'CREATE TABLE notes (id uuid); /* unclosed',
    'CREATE FUNCTION fn() RETURNS text AS $open$unclosed;',
    'CREATE TABLE notes (id uuid REFERENCES auth.users(id) ON DELETE CASCADE;',
    'CREATE TABLE notes (id uuid));',
    "CREATE TABLE notes (label text DEFAULT E'\\",
  ])('fails closed on incomplete lexical or table syntax: %s', (sql) => {
    expect(() => assertExplicitForeignKeyDelete(sql)).toThrow(/sintaxe SQL incompleta/)
  })

  it('tokenizes bounded SQL while preserving source ranges and quoted identifier case', () => {
    const sql = `-- ignored\nALTER /* outer /* nested */ done */ TABLE "public"."Some""Table"
      ADD "Owner" uuid REFERENCES auth.users(id) ON DELETE NO ACTION;
      SELECT 'literal''quote', E'escaped\\\'quote', $$body; REFERENCES ignored$$; -- eof`
    const tokens = tokenizeForeignKeySql(sql)
    expect(tokens.filter((token) => token.kind === 'identifier').map((token) => token.value)).toEqual(['public', 'Some"Table', 'Owner'])
    expect(tokens.filter((token) => token.kind === 'literal').map((token) => token.value)).toEqual(["literal'quote", "escaped\\'quote"])
    expect(tokens.filter((token) => token.kind === 'body').map((token) => token.value)).toEqual(['body; REFERENCES ignored'])
    expect(tokens[0]).toMatchObject({ kind: 'word', value: 'alter' })
    const quoted = tokens.find((token) => token.value === 'Some"Table')!
    expect(sql.slice(quoted.start, quoted.end)).toBe('"Some""Table"')
    expect(() => assertExplicitForeignKeyDelete(sql)).not.toThrow()
  })
})
