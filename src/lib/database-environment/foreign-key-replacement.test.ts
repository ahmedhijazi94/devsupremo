import { describe, expect, it } from 'vitest'
import { foreignKeyReplacementPreconditions, parseForeignKeyReplacements, type ForeignKeyReplacement } from './foreign-key-replacement'

const sql = 'ALTER TABLE public.orgs DROP CONSTRAINT orgs_owner_id_fkey, ADD CONSTRAINT orgs_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE NO ACTION;'
const expected: ForeignKeyReplacement = {
  table: 'orgs', constraint: 'orgs_owner_id_fkey', column: 'owner_id',
  referencedSchema: 'auth', referencedTable: 'users', referencedColumn: 'id',
}

describe('gramática da substituição equivalente de foreign keys', () => {
  it('reconhece a correção explícita do comportamento padrão sem alterar o SQL recebido', () => {
    expect(parseForeignKeyReplacements(sql)).toEqual([expected])
    expect(parseForeignKeyReplacements(sql.slice(0, -1))).toEqual([expected])
  })
  it('aceita somente substituições equivalentes em lote, comentários e identificadores quoted', () => {
    const second = 'alter table "public"."Invitations" drop constraint "Invitations_FK", add constraint "Invitations_FK" foreign key ("Creator") references "public"."Profiles"("ID") on delete no action;'
    expect(parseForeignKeyReplacements(`-- migration\n${sql}\n/* nested /* comment */ remains */ ${second}`)).toEqual([
      expected,
      { table: 'Invitations', constraint: 'Invitations_FK', column: 'Creator', referencedSchema: 'public', referencedTable: 'Profiles', referencedColumn: 'ID' },
    ])
  })
  it.each([
    '', 'SELECT 1;', '-- DROP TABLE orgs;\nSELECT 1;',
    "INSERT INTO notes (body) VALUES ('DROP TABLE orgs');",
    'SELECT $$DROP TABLE orgs$$;', 'SELECT "drop" FROM orgs;',
  ])('não infere uma exceção quando não existe token DROP real: %s', (input) => {
    expect(parseForeignKeyReplacements(input)).toEqual([])
  })
  it.each([
    'DROP TABLE public.orgs;',
    sql.replace('public.orgs', 'auth.users'),
    sql.replace('ALTER TABLE', 'ALTER TABLE ONLY'),
    sql.replace('DROP CONSTRAINT', 'DROP CONSTRAINT IF EXISTS'),
    sql.replace('orgs_owner_id_fkey,', 'orgs_owner_id_fkey CASCADE,'),
    sql.replace('ADD CONSTRAINT orgs_owner_id_fkey', 'ADD CONSTRAINT other_fkey'),
    sql.replace('(owner_id)', '(owner_id, org_id)'),
    sql.replace('auth.users', 'storage.objects'),
    sql.replace('REFERENCES auth.users(id)', 'REFERENCES users(id)'),
    sql.replace('(id)', '(id, org_id)'),
    sql.replace('ON DELETE NO ACTION', 'ON UPDATE NO ACTION'),
    sql.replace('NO ACTION;', 'NO ACTION NOT VALID;'),
    sql.replace('NO ACTION;', 'NO ACTION DEFERRABLE;'),
    sql.replace('NO ACTION;', 'NO ACTION ON UPDATE CASCADE;'),
    sql.replace('REFERENCES', 'MATCH FULL REFERENCES'),
    sql.replace('public.orgs', 'public.' + 'a'.repeat(64)),
    sql.replace('public.orgs', 'public."orgs; DROP TABLE users"'),
    sql.replace('public.orgs', 'public."org\'s"'),
    sql.replace('public.orgs', 'public."órgãos"'),
    sql.replace('DROP', '"drop"') + ' DROP TABLE users;',
    `${sql} INSERT INTO public.platform_admins (user_id) VALUES ('id');`,
    `CREATE TABLE another (id int); ${sql}`,
    `${sql} ALTER TABLE public.orgs DISABLE ROW LEVEL SECURITY;`,
    `${sql} DO $$BEGIN SELECT 1; END$$;`,
    `${sql} COMMIT;`,
    `${sql}${sql}`,
    sql.replace('NO ACTION;', ''),
    sql.replace('FOREIGN KEY', 'UNIQUE'),
    sql.replace('ADD CONSTRAINT', 'ADD COLUMN'),
    sql.replace('ON DELETE', 'ON /* unclosed comment DELETE'),
  ])('recusa mudança além da gramática de substituição: %s', (input) => {
    expect(() => parseForeignKeyReplacements(input)).toThrow(/revisão|recusada/)
  })
  it.each([['CASCADE','c'],['RESTRICT','r'],['SET NULL','n'],['SET DEFAULT','d']])('confere no catálogo a preservação de %s', (action,code)=>{
    const replacements=parseForeignKeyReplacements(sql.replace('NO ACTION',action!))
    expect(replacements[0]?.onDelete).toBe(action!.toLowerCase())
    expect(foreignKeyReplacementPreconditions(replacements)).toContain(`c.confdeltype = '${code}'`)
  })
  it('limita o lote mesmo quando todas as constraints são distintas', () => {
    const tooMany = Array.from({ length: 101 }, (_, i) => sql.replaceAll('orgs_owner_id_fkey', `fk_${i}`)).join('\n')
    expect(() => parseForeignKeyReplacements(tooMany)).toThrow(/revisão/)
  })
})

describe('precondições transacionais da substituição', () => {
  it('não gera operação para lote vazio', () => {
    expect(foreignKeyReplacementPreconditions([])).toBe('')
  })
  it('trava origens e destinos em ordem determinística antes de consultar equivalência', () => {
    const second = { ...expected, table: 'invitations', constraint: 'creator_fk' }
    const statements = foreignKeyReplacementPreconditions([expected, second])
    const locks = statements.split('\n').filter(line => line.startsWith('LOCK TABLE'))
    expect(locks).toEqual([
      'LOCK TABLE ONLY "auth"."users" IN ACCESS EXCLUSIVE MODE;',
      'LOCK TABLE ONLY "public"."invitations" IN ACCESS EXCLUSIVE MODE;',
      'LOCK TABLE ONLY "public"."orgs" IN ACCESS EXCLUSIVE MODE;',
    ])
    expect(statements.indexOf(locks[2]!)).toBeLessThan(statements.indexOf('DO $supremo_fk_equivalence$'))
    expect(statements).not.toMatch(/\b(?:DROP|ALTER|COMMIT|ROLLBACK|EXECUTE)\b/)
  })
  it('exige identidade, colunas, ações, validação, RLS e enforcement iguais antes de executar', () => {
    const statements = foreignKeyReplacementPreconditions([expected])
    for (const proof of [
      "source_schema.nspname = 'public' AND source_table.relname = 'orgs'",
      "target_schema.nspname = 'auth' AND target_table.relname = 'users'",
      "c.conname = 'orgs_owner_id_fkey' AND c.contype = 'f'",
      "source_column.attname = 'owner_id'", "target_column.attname = 'id'",
      'c.conkey = ARRAY[source_column.attnum]', 'c.confkey = ARRAY[target_column.attnum]',
      "c.confdeltype = 'a' AND c.confupdtype = 'a' AND c.confmatchtype = 's'",
      'NOT c.condeferrable AND NOT c.condeferred AND c.convalidated',
      'c.conparentid = 0 AND c.coninhcount = 0 AND c.conislocal',
      "COALESCE((pg_catalog.to_jsonb(c)->>'conenforced')::pg_catalog.bool, true)",
      "NOT COALESCE((pg_catalog.to_jsonb(c)->>'conperiod')::pg_catalog.bool, false)",
      "source_table.relkind = 'r' AND NOT source_table.relispartition AND source_table.relrowsecurity",
      "target_table.relkind = 'r' AND NOT target_table.relispartition",
      'pg_catalog.pg_inherits', 'trg.tgconstraint = c.oid) = 4',
      "NOT trg.tgisinternal OR trg.tgenabled <> 'O' OR trg.tgparentid <> 0",
      'RAISE EXCEPTION',
    ]) expect(statements).toContain(proof)
  })
  it.each(['table', 'constraint', 'column', 'referencedTable', 'referencedColumn'] as const)('revalida %s mesmo fora do parser', (field) => {
    expect(() => foreignKeyReplacementPreconditions([{ ...expected, [field]: "a'; DROP TABLE orgs; --" }])).toThrow()
    expect(() => foreignKeyReplacementPreconditions([{ ...expected, [field]: undefined } as unknown as ForeignKeyReplacement])).toThrow()
  })
  it('recusa schema, duplicatas e lote excessivo mesmo fora do parser', () => {
    expect(() => foreignKeyReplacementPreconditions([{ ...expected, referencedSchema: 'storage' as 'auth' }])).toThrow()
    expect(() => foreignKeyReplacementPreconditions([expected, expected])).toThrow()
    expect(() => foreignKeyReplacementPreconditions(Array.from({ length: 101 }, () => expected))).toThrow()
  })
})
