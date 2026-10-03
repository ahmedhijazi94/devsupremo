import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { buildDeleteApply, buildDeleteCatalogQuery, buildDeleteInspection, deleteCatalogSchema, deleteSnapshotSchema, validateDeleteCatalog, type DeleteCatalog, type DeleteSnapshot } from './sql'
import { type DeleteTarget } from './contract'

const targets: DeleteTarget[] = [{ table: 'memberships', key: { org_id: 'org-1', user_id: 'user-1' } }, { table: 'orgs', key: { id: 'org-1' } }]
function fixture(): DeleteCatalog {
  const table = (tableName: string, keys: string[]) => ({
    oid: tableName === 'orgs' ? 1 : 2, schema: 'public', name: tableName, kind: 'r', rls: true,
    partition: false, inherits: false, accessMethod: 'heap',
    columns: keys.map(key => ({ name: key, type: 'text', typeSchema: 'pg_catalog', kind: 'b', generated: '', collationSchema: 'pg_catalog' })),
    primaryKey: keys, primaryKeyImmediate: true, indexesSafe: true, indexes: [], indirectSideEffects: false, deleteTriggers: [], deleteRules: [],
  })
  return { version: 1, tables: [table('memberships', ['org_id', 'user_id']), table('orgs', ['id'])], foreignKeys: [{
    oid: 3, name: 'member_org', schema: 'public', table: 'memberships', referencedSchema: 'public', referencedTable: 'orgs',
    columns: ['org_id'], referencedColumns: ['id'], onDelete: 'c', validated: true, deferrable: false, operatorsSafe: true, definition: 'FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE CASCADE',
  }] }
}
function approvedSnapshot(): DeleteSnapshot {
  return { catalogFingerprint: 'a'.repeat(64), rows: targets.map((_, index) => ({ index, count: 1, fingerprint: String(index + 1).repeat(64) })), impactCount: 2, undeclaredDependencies: 0, ready: true }
}

describe('bounded deletion SQL', () => {
  it('supports full composite keys and explicit child-before-parent targets', () => {
    expect(validateDeleteCatalog(targets, fixture())).toEqual(fixture())
    const sql = buildDeleteApply(targets, fixture(), approvedSnapshot())
    expect(sql).toContain('BEGIN;')
    expect(sql).toContain('LOCK TABLE "public"."memberships", "public"."orgs" IN ACCESS EXCLUSIVE MODE')
    expect(sql.indexOf('LOCK TABLE')).toBeLessThan(sql.indexOf('DO $supremo_delete$'))
    expect(sql.indexOf('DELETE FROM "public"."memberships"')).toBeLessThan(sql.indexOf('DELETE FROM "public"."orgs"'))
    expect(sql).toContain('SUPREMO_DELETE_CHANGED')
    expect(sql).toContain('SUPREMO_DELETE_DEPENDENCIES')
    expect(sql.match(/SUPREMO_DELETE_COUNT/g)).toHaveLength(2)
    expect(sql).toContain('COMMIT;')
    expect(sql).not.toMatch(/DISABLE ROW LEVEL SECURITY|CASCADE;/)
  })

  it('returns hashes and counts, not raw application rows', () => {
    const sql = buildDeleteInspection(targets, fixture())
    expect(sql).toContain("'catalogFingerprint'")
    expect(sql).toContain("'undeclaredDependencies'")
    expect(sql).toContain('pg_catalog.sha256')
    expect(sql).toContain("'xmin',r.xmin::text")
    expect(sql).toContain('LIMIT 26')
    expect(sql).toContain('SET LOCAL row_security = off')
    expect(sql).not.toContain('RETURNING *')
    expect(sql).not.toContain('org-1')
  })

  it('inspects incoming references without filtering their source schema', () => {
    const sql = buildDeleteCatalogQuery(targets)
    expect(sql).toContain("k.contype='f' AND k.confrelid IN (SELECT oid FROM targets)")
    expect(sql).toContain('SELECT oid FROM targets UNION SELECT conrelid FROM refs')
    expect(sql).toContain('LIMIT 101')
    expect(sql).toContain('LIMIT 201')
    expect(sql).toContain('pg_catalog.pg_trigger')
    expect(sql).toContain('pg_catalog.pg_rewrite')
  })

  it('escapes SQL metacharacters including the surrounding dollar quote', () => {
    const dangerous = "org'); DELETE FROM auth.users; -- $supremo_delete$ \\ '"
    const attackTargets = [{ table: 'orgs', key: { id: dangerous } }]
    const catalog = fixture()
    const sql = buildDeleteInspection(attackTargets, catalog)
    expect(sql).not.toContain(dangerous)
    expect(sql).not.toContain('DELETE FROM auth.users')
    expect(sql).toContain(Buffer.from(dangerous).toString('hex'))
    expect(() => buildDeleteCatalogQuery([{ table: 'orgs;DROP TABLE orgs', key: { id: '1' } }])).toThrow()
  })

  it('keeps all FK delete behaviors in the explicit dependency check', () => {
    for (const action of ['a', 'r', 'c', 'n', 'd']) {
      const catalog = fixture(); catalog.foreignKeys[0]!.onDelete = action
      const sql = buildDeleteInspection([{ table: 'orgs', key: { id: 'org-1' } }], catalog)
      expect(sql).toContain('FROM "public"."memberships" d JOIN "public"."orgs" p')
    }
  })

  it.each([
    ['external schema', (c: DeleteCatalog) => { c.tables[0]!.schema = 'private' }],
    ['unquoted exotic name', (c: DeleteCatalog) => { c.tables[0]!.name = 'bad-name' }],
    ['view', (c: DeleteCatalog) => { c.tables[0]!.kind = 'v' }],
    ['RLS disabled', (c: DeleteCatalog) => { c.tables[0]!.rls = false }],
    ['partition', (c: DeleteCatalog) => { c.tables[0]!.partition = true }],
    ['inheritance', (c: DeleteCatalog) => { c.tables[0]!.inherits = true }],
    ['custom access method', (c: DeleteCatalog) => { c.tables[0]!.accessMethod = 'custom' }],
    ['expression or partial index', (c: DeleteCatalog) => { c.tables[0]!.indexesSafe = false }],
    ['indirect statement trigger', (c: DeleteCatalog) => { c.tables[0]!.indirectSideEffects = true }],
    ['delete rule', (c: DeleteCatalog) => { c.tables[0]!.deleteRules = ['rule'] }],
    ['missing PK', (c: DeleteCatalog) => { c.tables[0]!.primaryKey = [] }],
    ['deferred PK', (c: DeleteCatalog) => { c.tables[0]!.primaryKeyImmediate = false }],
    ['duplicated PK', (c: DeleteCatalog) => { c.tables[0]!.primaryKey = ['org_id', 'org_id'] }],
    ['duplicated column', (c: DeleteCatalog) => { c.tables[0]!.columns.push(c.tables[0]!.columns[0]!) }],
    ['missing PK column', (c: DeleteCatalog) => { c.tables[0]!.primaryKey = ['missing'] }],
    ['JSON primary key', (c: DeleteCatalog) => { c.tables[0]!.columns[0]!.type = 'jsonb' }],
    ['custom type', (c: DeleteCatalog) => { c.tables[0]!.columns[0]!.typeSchema = 'public' }],
    ['enum type', (c: DeleteCatalog) => { c.tables[0]!.columns[0]!.kind = 'e' }],
    ['unknown built-in type', (c: DeleteCatalog) => { c.tables[0]!.columns[0]!.type = 'regproc' }],
    ['generated column', (c: DeleteCatalog) => { c.tables[0]!.columns[0]!.generated = 's' }],
    ['custom collation', (c: DeleteCatalog) => { c.tables[0]!.columns[0]!.collationSchema = 'public' }],
    ['invalid column identifier', (c: DeleteCatalog) => { c.tables[0]!.columns[0]!.name = 'bad-name' }],
    ['missing child table', (c: DeleteCatalog) => { c.foreignKeys[0]!.table = 'unknown' }],
    ['missing parent table', (c: DeleteCatalog) => { c.foreignKeys[0]!.referencedTable = 'unknown' }],
    ['unvalidated FK', (c: DeleteCatalog) => { c.foreignKeys[0]!.validated = false }],
    ['custom FK equality', (c: DeleteCatalog) => { c.foreignKeys[0]!.operatorsSafe = false }],
    ['incomplete FK key', (c: DeleteCatalog) => { c.foreignKeys[0]!.columns.push('user_id') }],
    ['unknown FK action', (c: DeleteCatalog) => { c.foreignKeys[0]!.onDelete = 'x' }],
    ['unknown FK child column', (c: DeleteCatalog) => { c.foreignKeys[0]!.columns = ['missing'] }],
    ['unknown FK parent column', (c: DeleteCatalog) => { c.foreignKeys[0]!.referencedColumns = ['missing'] }],
  ] as const)('rejects %s', (_label, mutate) => {
    const catalog = fixture(); mutate(catalog)
    expect(() => validateDeleteCatalog(targets, catalog)).toThrow()
  })

  it('rejects non-internal or unsafe and disabled DELETE triggers', () => {
    const safeTrigger = { name: 'fk_delete', internal: true, enabled: 'O', functionSchema: 'pg_catalog', functionName: 'RI_FKey_cascade_del', definition: 'internal' }
    const catalog = fixture(); catalog.tables[1]!.deleteTriggers = [safeTrigger]
    expect(() => validateDeleteCatalog(targets, catalog)).not.toThrow()
    for (const patch of [{ internal: false }, { functionSchema: 'public' }, { functionName: 'custom_delete' }, { enabled: 'D' }]) {
      catalog.tables[1]!.deleteTriggers = [{ ...safeTrigger, ...patch }]
      expect(() => validateDeleteCatalog(targets, catalog)).toThrow(/triggers/)
    }
  })

  it('requires complete keys, unique rows, exact numeric values and known tables', () => {
    for (const input of [
      [{ table: 'memberships', key: { org_id: '1' } }],
      [{ table: 'orgs', key: { other: '1' } }],
      [{ table: 'missing', key: { id: '1' } }],
      [{ table: 'orgs', key: { id: '\0' } }],
      [{ table: 'orgs', key: { id: Number.MAX_SAFE_INTEGER + 1 } }],
      [targets[1]!, targets[1]!],
    ]) expect(() => validateDeleteCatalog(input, fixture())).toThrow()
    const duplicated = fixture(); duplicated.tables.push(duplicated.tables[0]!)
    expect(() => validateDeleteCatalog(targets, duplicated)).toThrow(/duplicadas/)
  })

  it('rejects parent-first order, self references and unrelated catalog edges', () => {
    expect(() => validateDeleteCatalog([...targets].reverse(), fixture())).toThrow(/primeiro/)
    const self = fixture(); self.foreignKeys[0]!.table = 'orgs'; self.foreignKeys[0]!.columns = ['id']
    expect(() => validateDeleteCatalog([targets[1]!], self)).toThrow(/autorreferências/)
    expect(() => validateDeleteCatalog([targets[0]!], fixture())).toThrow(/fora dos alvos/)
  })

  it('does not require unrelated columns, keys or delete triggers on reference-only tables', () => {
    const catalog = fixture()
    const child = catalog.tables[0]!
    child.primaryKey = []; child.primaryKeyImmediate = false
    child.columns.push({ name: 'custom', type: 'status', typeSchema: 'public', kind: 'e', generated: '', collationSchema: null })
    child.deleteTriggers = [{ name: 'audit', internal: false, enabled: 'O', functionSchema: 'public', functionName: 'audit_delete', definition: 'trigger' }]
    expect(() => validateDeleteCatalog([targets[1]!], catalog)).not.toThrow()
    child.columns[0]!.typeSchema = 'public'
    expect(() => validateDeleteCatalog([targets[1]!], catalog)).toThrow(/Tipo/)
  })

  it('refuses unready, incomplete or mismatched snapshots before generating a write', () => {
    for (const patch of [{ ready: false }, { impactCount: 1 }, { undeclaredDependencies: 1 }, { rows: [approvedSnapshot().rows[0]!] }, { rows: [...approvedSnapshot().rows].reverse() }, { rows: [{ index: 0, count: 0, fingerprint: null }, approvedSnapshot().rows[1]!] }]) {
      expect(() => buildDeleteApply(targets, fixture(), { ...approvedSnapshot(), ...patch })).toThrow(/plano/)
    }
    expect(() => buildDeleteCatalogQuery(Array.from({ length: 26 }, () => targets[1]!))).toThrow()
    expect(() => deleteCatalogSchema.parse({ ...fixture(), unexpected: true })).toThrow()
    expect(() => deleteSnapshotSchema.parse({ ...approvedSnapshot(), rawRows: ['secret'] })).toThrow()
  })
})

// Opt-in acceptance against local PostgreSQL only. Always creates its own
// disposable database; never resets the database named by the connection URL.
describe.skipIf(process.env.SUPREMO_DELETE_TEST_PG !== '1')('PostgreSQL atomic deletion acceptance', () => {
  const suffix = `${process.pid}_${randomUUID().replaceAll('-', '').slice(0, 12)}`
  const db = `supremo_delete_fixture_${suffix}`
  const reader = `delete_reader_${suffix}`
  let created = false
  const connection = new URL(process.env.SUPREMO_TEST_DATABASE_URL ?? 'postgresql://postgres@127.0.0.1:56479/postgres')
  const adminDatabase = connection.pathname.slice(1) || 'postgres'
  const run = (sql: string, database = db): string => {
    if (!['postgres:', 'postgresql:'].includes(connection.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(connection.hostname) || connection.search)
      throw new Error('Deletion acceptance requires a local PostgreSQL fixture without URL overrides.')
    return execFileSync(process.env.SUPREMO_TEST_PSQL ?? 'psql', ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-h', connection.hostname.replaceAll(/[\[\]]/g, ''), '-p', connection.port || '5432', '-U', decodeURIComponent(connection.username) || 'postgres', '-d', database], {
      input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
      env: { NODE_ENV: 'test', PATH: process.env.PATH, PGPASSWORD: decodeURIComponent(connection.password), PGPASSFILE: '/dev/null', PGHOSTADDR: connection.hostname === '[::1]' ? '::1' : '127.0.0.1' },
    }).trim()
  }
  const org = '11111111-1111-4111-8111-111111111111', user = '22222222-2222-4222-8222-222222222222'
  const exact: DeleteTarget[] = [{ table: 'memberships', key: { org_id: org, user_id: user } }, { table: 'orgs', key: { id: org } }]
  const inspect = (requested = exact) => {
    const catalog = validateDeleteCatalog(requested, JSON.parse(run(`BEGIN READ ONLY; ${buildDeleteCatalogQuery(requested)} COMMIT;`)))
    const snapshot = deleteSnapshotSchema.parse(JSON.parse(run(`BEGIN READ ONLY; ${buildDeleteInspection(requested, catalog)} COMMIT;`)))
    return { catalog, snapshot }
  }
  beforeAll(() => {
    run(`CREATE DATABASE ${db}`, adminDatabase)
    created = true
  })
  afterAll(() => {
    if (created) {
      run(`DROP DATABASE ${db} WITH (FORCE)`, adminDatabase)
      run(`DROP ROLE IF EXISTS ${reader}`, adminDatabase)
    }
  })
  beforeEach(() => {
    run(`DROP SCHEMA public CASCADE; CREATE SCHEMA public; DROP SCHEMA IF EXISTS auth CASCADE; CREATE SCHEMA auth;
      CREATE TABLE auth.users(id uuid PRIMARY KEY, master boolean NOT NULL);
      CREATE TABLE public.orgs(id uuid PRIMARY KEY, owner_id uuid REFERENCES auth.users(id) ON DELETE RESTRICT, name text);
      CREATE TABLE public.memberships(org_id uuid REFERENCES public.orgs(id) ON DELETE CASCADE, user_id uuid REFERENCES auth.users(id) ON DELETE RESTRICT, PRIMARY KEY(org_id,user_id));
      ALTER TABLE public.orgs ENABLE ROW LEVEL SECURITY; ALTER TABLE public.memberships ENABLE ROW LEVEL SECURITY;
      INSERT INTO auth.users VALUES('${user}',true); INSERT INTO public.orgs VALUES('${org}','${user}','Fixture'); INSERT INTO public.memberships VALUES('${org}','${user}');`)
  })

  it('blocks an undeclared cascade; explicit membership and org deletion preserves auth and Master', () => {
    const blocked = inspect([exact[1]!])
    expect(blocked.snapshot).toMatchObject({ ready: false, impactCount: 1, undeclaredDependencies: 1 })
    expect(() => buildDeleteApply([exact[1]!], blocked.catalog, blocked.snapshot)).toThrow()
    const { catalog, snapshot } = inspect()
    expect(snapshot).toMatchObject({ ready: true, impactCount: 2, undeclaredDependencies: 0 })
    expect(run(buildDeleteApply(exact, catalog, snapshot))).toBe('2')
    expect(run('SELECT count(*) FROM public.orgs')).toBe('0')
    expect(run('SELECT count(*) FROM public.memberships')).toBe('0')
    expect(run('SELECT count(*) FROM auth.users WHERE master')).toBe('1')
  })

  it('rolls back when a row or schema changes after inspection', () => {
    let plan = inspect()
    run("UPDATE public.orgs SET name='Changed'")
    expect(() => run(buildDeleteApply(exact, plan.catalog, plan.snapshot))).toThrow(/SUPREMO_DELETE_CHANGED/)
    expect(run('SELECT count(*) FROM public.memberships')).toBe('1')
    plan = inspect()
    run('ALTER TABLE public.orgs ADD COLUMN extra text')
    expect(() => run(buildDeleteApply(exact, plan.catalog, plan.snapshot))).toThrow(/SUPREMO_DELETE_CHANGED/)
    expect(run('SELECT count(*) FROM public.orgs')).toBe('1')
  })

  it('rolls back when an undeclared dependency appears after inspection', () => {
    const plan = inspect()
    run(`INSERT INTO auth.users VALUES('33333333-3333-4333-8333-333333333333',false); INSERT INTO public.memberships VALUES('${org}','33333333-3333-4333-8333-333333333333')`)
    expect(() => run(buildDeleteApply(exact, plan.catalog, plan.snapshot))).toThrow(/SUPREMO_DELETE_DEPENDENCIES/)
    expect(run('SELECT count(*) FROM public.memberships')).toBe('2')
    expect(run('SELECT count(*) FROM public.orgs')).toBe('1')
  })

  it('detects new external references and custom delete triggers before write', () => {
    const plan = inspect()
    run('CREATE TABLE auth.references_org(org_id uuid REFERENCES public.orgs(id)); ALTER TABLE auth.references_org ENABLE ROW LEVEL SECURITY')
    expect(() => inspect()).toThrow(/referência externa/)
    expect(() => run(buildDeleteApply(exact, plan.catalog, plan.snapshot))).toThrow(/SUPREMO_DELETE_CHANGED/)
    run('DROP TABLE auth.references_org; CREATE FUNCTION public.delete_side_effect() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN OLD; END $$; CREATE TRIGGER unsafe_delete BEFORE DELETE ON public.orgs FOR EACH ROW EXECUTE FUNCTION public.delete_side_effect()')
    expect(() => inspect()).toThrow(/triggers/)
    expect(run('SELECT count(*) FROM public.orgs')).toBe('1')
  })

  it('does not mistake RLS-hidden dependencies for no impact', () => {
    run(`CREATE ROLE ${reader}; GRANT USAGE ON SCHEMA public TO ${reader}; GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${reader}`)
    const catalog = inspect().catalog
    expect(() => run(`BEGIN READ ONLY; SET LOCAL ROLE ${reader}; ${buildDeleteInspection(exact, catalog)} COMMIT;`)).toThrow(/row-level security/)
    run(`DROP OWNED BY ${reader}; DROP ROLE ${reader}`)
  })

  it('allows empty incoming tables with unrelated enums, arrays and DELETE triggers', () => {
    run(`CREATE TYPE public.ref_status AS ENUM('a','b');
      CREATE TABLE public.optional_refs(org_id uuid REFERENCES public.orgs(id) ON DELETE SET NULL, status public.ref_status, tags text[]);
      ALTER TABLE public.optional_refs ENABLE ROW LEVEL SECURITY;
      CREATE FUNCTION public.optional_delete_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'must not run'; END $$;
      CREATE TRIGGER custom_optional_delete BEFORE DELETE ON public.optional_refs FOR EACH ROW EXECUTE FUNCTION public.optional_delete_audit()`)
    const plan = inspect()
    expect(plan.snapshot.ready).toBe(true)
    expect(run(buildDeleteApply(exact, plan.catalog, plan.snapshot))).toBe('2')
    expect(run('SELECT count(*) FROM public.optional_refs')).toBe('0')
  })

  it('blocks undeclared SET NULL and RESTRICT references too', () => {
    for (const action of ['SET NULL', 'RESTRICT', 'NO ACTION', 'SET DEFAULT']) {
      run(`CREATE TABLE public.optional_refs(id int PRIMARY KEY, org_id uuid REFERENCES public.orgs(id) ON DELETE ${action}); ALTER TABLE public.optional_refs ENABLE ROW LEVEL SECURITY; INSERT INTO public.optional_refs VALUES(1,'${org}')`)
      const plan = inspect()
      expect(plan.snapshot).toMatchObject({ ready: false, undeclaredDependencies: 1 })
      expect(() => buildDeleteApply(exact, plan.catalog, plan.snapshot)).toThrow()
      run('DROP TABLE public.optional_refs')
    }
  })

  it('rejects statement triggers even on empty incoming tables', () => {
    run(`CREATE TABLE public.optional_refs(id int PRIMARY KEY, org_id uuid REFERENCES public.orgs(id) ON DELETE SET NULL);
      ALTER TABLE public.optional_refs ENABLE ROW LEVEL SECURITY;
      CREATE FUNCTION public.statement_side_effect() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'statement side effect'; END $$;
      CREATE TRIGGER unsafe_statement AFTER UPDATE ON public.optional_refs FOR EACH STATEMENT EXECUTE FUNCTION public.statement_side_effect()`)
    // PostgreSQL's SET NULL action executes UPDATE even with zero child rows.
    expect(() => run(`BEGIN; DELETE FROM public.orgs WHERE id='${org}'; ROLLBACK;`)).toThrow(/statement side effect/)
    expect(() => inspect()).toThrow(/efeitos indiretos/)
    expect(run('SELECT count(*) FROM public.orgs')).toBe('1')
    expect(run('SELECT count(*) FROM public.memberships')).toBe('1')
  })

  it('rejects two differently typed keys selecting the same row', () => {
    run('CREATE TABLE public.numeric_items(id int PRIMARY KEY); ALTER TABLE public.numeric_items ENABLE ROW LEVEL SECURITY; INSERT INTO public.numeric_items VALUES(1)')
    const duplicated = [{ table: 'numeric_items', key: { id: 1 } }, { table: 'numeric_items', key: { id: '1' } }]
    const plan = inspect(duplicated)
    expect(plan.snapshot).toMatchObject({ ready: false, impactCount: 2, undeclaredDependencies: 0 })
    expect(() => buildDeleteApply(duplicated, plan.catalog, plan.snapshot)).toThrow()
    expect(run('SELECT count(*) FROM public.numeric_items')).toBe('1')
  })
})
