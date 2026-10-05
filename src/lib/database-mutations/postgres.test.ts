import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest'
import {
  mutationCatalogQuery,
  mutationCatalogSchema,
  mutationInspectionSql,
  mutationSnapshotSchema,
  mutationApplySql,
} from './sql'
import { type MutationAction } from './contract'
import {
  buildDeleteCatalogQuery,
  buildDeleteInspection,
  buildDeleteApply,
  deleteCatalogSchema,
  deleteSnapshotSchema,
} from '../database-delete/sql'
import { authAdministrationSql } from '../database-admin/administration-sql'
import { currentApplicationRole } from '../database-admin/claims'
import {
  parseForeignKeyReplacements,
  foreignKeyReplacementPreconditions,
} from '../database-environment/foreign-key-replacement'

/** Opt-in real PostgreSQL proof. Creates/drops only its own random database;
 * requires a private socket or an explicitly configured localhost/postgres test URL. */
describe.skipIf(!process.env.SUPREMO_MUTATION_TEST_SOCKET && !process.env.SUPREMO_TEST_DATABASE_URL)(
  'administrative operations on disposable PostgreSQL',
  () => {
    const socket = process.env.SUPREMO_MUTATION_TEST_SOCKET ?? ''
    const database = `supremo_mutation_${randomUUID().replaceAll('-', '')}`
    const target = process.env.SUPREMO_TEST_DATABASE_URL ? new URL(process.env.SUPREMO_TEST_DATABASE_URL) : null
    const validTarget = target ? ['postgres:', 'postgresql:'].includes(target.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) && !target.search && !target.hash && target.pathname === '/postgres' : /^\/(?:private\/)?tmp\/supremo-mutations-pg\.[A-Za-z0-9]+$/.test(socket)
    const id = '11111111-1111-4111-8111-111111111111',
      other = '22222222-2222-4222-8222-222222222222'
    const session = '33333333-3333-4333-8333-333333333333'
    const run = (sql: string, db = database): string => {
      if (!validTarget)
        throw new Error('Private local fixture socket required')
      return execFileSync(
        process.env.SUPREMO_TEST_PSQL ?? 'psql',
        [
          '-X',
          '-q',
          '-A',
          '-t',
          '-v',
          'ON_ERROR_STOP=1',
          '-h',
          target?.hostname ?? socket,
          '-p',
          target ? target.port || '5432' : '56489',
          '-U',
          target ? decodeURIComponent(target.username || 'postgres') : 'postgres',
          '-d',
          db,
        ],
        {
          input: sql,
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { NODE_ENV: 'test', PATH: process.env.PATH, PGPASSFILE: '/dev/null', ...(target ? { PGPASSWORD: decodeURIComponent(target.password) } : {}) },
        },
      ).trim()
    }
    const plan = (action: MutationAction) => {
      const catalog = mutationCatalogSchema.parse(
        JSON.parse(run(mutationCatalogQuery(action.table))),
      )
      const snapshot = mutationSnapshotSchema.parse(
        JSON.parse(
          run(
            `BEGIN READ ONLY; ${mutationInspectionSql(action, catalog)} COMMIT;`,
          ),
        ),
      )
      return { catalog, snapshot }
    }
    beforeAll(() => {
      run(`CREATE DATABASE ${database}`, 'postgres')
    })
    afterAll(() => {
      run(`DROP DATABASE ${database} WITH (FORCE)`, 'postgres')
    })
    beforeEach(() => {
      run(`DROP SCHEMA public CASCADE;CREATE SCHEMA public;DROP SCHEMA IF EXISTS auth CASCADE;CREATE SCHEMA auth;
    CREATE TYPE public.mood AS ENUM ('draft','live');
    CREATE TABLE public.notes(id uuid PRIMARY KEY,title text NOT NULL,mood public.mood,tags text[] DEFAULT '{}'::text[],title_length integer GENERATED ALWAYS AS (char_length(title)) STORED);
    ALTER TABLE public.notes ENABLE ROW LEVEL SECURITY;
    INSERT INTO public.notes(id,title,mood,tags) VALUES ('${id}','First','live',ARRAY['private']),('${other}','Other','draft',ARRAY['other']);
    CREATE TABLE auth.users(id uuid PRIMARY KEY,raw_app_meta_data jsonb,updated_at timestamptz);
    CREATE TABLE auth.sessions(id uuid PRIMARY KEY,user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE);
    CREATE TABLE auth.refresh_tokens(user_id text);
    INSERT INTO auth.users VALUES('${id}','{"provider":"email","supremo":{"keep":"original","roles":["master"],"roles_revision":"${id}"}}',now()),('${other}','{}',now());
    INSERT INTO auth.sessions VALUES('${session}','${id}'),('${other}','${other}');INSERT INTO auth.refresh_tokens VALUES('${id}'),('${other}');`)
    })
    it('updates a business field while preserving enum/array and safely recomputing a generated column', () => {
      const action: MutationAction = {
        type: 'update',
        table: 'notes',
        rows: [
          {
            key: { id },
            values: { title: "DROP; '$supremo_mutation$; updated" },
          },
        ],
      }
      const { catalog, snapshot } = plan(action)
      expect(snapshot.ready).toBe(true)
      expect(run(mutationApplySql(action, catalog, snapshot))).toBe('1')
      const row = JSON.parse(
        run(`SELECT row_to_json(n) FROM public.notes n WHERE id='${id}'`),
      ) as { title: string; mood: string; tags: string[]; title_length: number }
      expect(row).toMatchObject({
        title: action.rows[0]!.values.title,
        mood: 'live',
        tags: ['private'],
      })
      expect(row.title_length).toBe(row.title.length)
      expect(run(`SELECT title FROM public.notes WHERE id='${other}'`)).toBe(
        'Other',
      )
    })
    it('inserts and upserts exact keys, with no accidental application of SQL in values', () => {
      const key = '44444444-4444-4444-8444-444444444444'
      for (const [type, value] of [
        ['insert', 'New'],
        ['upsert', 'Changed'],
      ] as const) {
        const action: MutationAction = {
          type,
          table: 'notes',
          rows: [{ key: { id: key }, values: { title: value } }],
        }
        const { catalog, snapshot } = plan(action)
        expect(snapshot.ready).toBe(true)
        expect(run(mutationApplySql(action, catalog, snapshot))).toBe('1')
        expect(run(`SELECT title FROM public.notes WHERE id='${key}'`)).toBe(
          value,
        )
      }
    })
    it('rolls back stale row and schema plans before any data change', () => {
      const action: MutationAction = {
        type: 'update',
        table: 'notes',
        rows: [{ key: { id }, values: { title: 'planned' } }],
      }
      let prepared = plan(action)
      run(`UPDATE public.notes SET title='Concurrent' WHERE id='${id}'`)
      expect(() =>
        run(mutationApplySql(action, prepared.catalog, prepared.snapshot)),
      ).toThrow(/SUPREMO_MUTATION_CHANGED/)
      expect(run(`SELECT title FROM public.notes WHERE id='${id}'`)).toBe(
        'Concurrent',
      )
      prepared = plan(action)
      run('ALTER TABLE public.notes ADD COLUMN added text')
      expect(() =>
        run(mutationApplySql(action, prepared.catalog, prepared.snapshot)),
      ).toThrow(/SUPREMO_MUTATION_CHANGED/)
    })
    it('deletes an exact row with enum/array/generated data while preserving another owner row', () => {
      const targets = [{ table: 'notes', key: { id } }]
      const catalog = deleteCatalogSchema.parse(
        JSON.parse(
          run(`BEGIN READ ONLY;${buildDeleteCatalogQuery(targets)}COMMIT;`),
        ),
      )
      const snapshot = deleteSnapshotSchema.parse(
        JSON.parse(
          run(
            `BEGIN READ ONLY;${buildDeleteInspection(targets, catalog)}COMMIT;`,
          ),
        ),
      )
      expect(run(buildDeleteApply(targets, catalog, snapshot))).toBe('1')
      expect(run('SELECT count(*) FROM public.notes')).toBe('1')
    })
    it('atomically merges server claims and revokes only the target refresh sessions; old JWT loses role through live revision checking', () => {
      const result = run(authAdministrationSql(id, ['editor'])).split('|')
      expect(result[0]).toBe(id)
      expect(result[1]).toBe('1')
      const metadata: unknown = JSON.parse(
        run(`SELECT raw_app_meta_data FROM auth.users WHERE id='${id}'`),
      )
      expect(metadata).toMatchObject({
        provider: 'email',
        supremo: { keep: 'original', roles: ['editor'] },
      })
      expect(
        run(`SELECT count(*) FROM auth.sessions WHERE user_id='${other}'`),
      ).toBe('1')
      expect(
        run(`SELECT count(*) FROM auth.refresh_tokens WHERE user_id='${id}'`),
      ).toBe('0')
      expect(
        currentApplicationRole({
          verifiedJwt: {
            sub: id,
            session_id: session,
            app_metadata: {
              supremo: { roles: ['master'], roles_revision: id },
            },
          },
          current: {
            userId: id,
            sessionId: session,
            active: false,
            appMetadata: metadata,
          },
          requiredRole: 'master',
        }),
      ).toBe(false)
    })
    it('replaces a CASCADE foreign key only when its existing behavior matches', () => {
      run(
        'CREATE TABLE public.parents(id uuid PRIMARY KEY); ALTER TABLE public.parents ENABLE ROW LEVEL SECURITY; CREATE TABLE public.children(id uuid PRIMARY KEY,parent_id uuid CONSTRAINT fk_parent REFERENCES public.parents(id) ON DELETE CASCADE); ALTER TABLE public.children ENABLE ROW LEVEL SECURITY;',
      )
      const sql =
        'ALTER TABLE public.children DROP CONSTRAINT fk_parent, ADD CONSTRAINT fk_parent FOREIGN KEY(parent_id) REFERENCES public.parents(id) ON DELETE CASCADE;'
      const checks = foreignKeyReplacementPreconditions(
        parseForeignKeyReplacements(sql),
      )
      expect(() => run(`BEGIN;${checks}${sql}COMMIT;`)).not.toThrow()
      const changed = sql.replace('CASCADE', 'RESTRICT')
      expect(() =>
        run(
          `BEGIN;${foreignKeyReplacementPreconditions(parseForeignKeyReplacements(changed))}${changed}COMMIT;`,
        ),
      ).toThrow(/incompatível/)
    })
  },
)
