import { describe, it, expect } from 'vitest'
import {
  jobsManifestSchema,
  jobManifestEntrySchema,
  jobsRequestSchema,
  validSchedule,
} from './policy'
import {
  validateJobTable,
  quoteLiteral,
  tableCatalogSql,
  type JobTable,
} from './catalog'
import { compileJob, valueSql } from './compile'
import {
  applyJobsSql,
  bootstrapJobsSql,
  historyJobsSql,
  listJobsSql,
  mutateJobSql,
  runtimeJobSql,
} from './sql'

const project = '8ff6cf10-940d-4c45-907d-7fe8f753a5d0'
const definition = () =>
  jobManifestEntrySchema.parse({
    id: 'overdue',
    schedule: '*/5 * * * *',
    timezone: 'UTC',
    action: {
      type: 'update',
      table: 'tickets',
      set: { status: 'overdue' },
      where: [{ column: 'created_at', op: 'older_than', minutes: 1440 }],
    },
  })
const column = (name: string, type = 'text') => ({
  name,
  type,
  schema: 'pg_catalog',
  kind: 'b',
  generated: '',
  collation_schema: null,
})
const table = (): JobTable => ({
  oid: 100,
  name: 'tickets',
  kind: 'r',
  rls: true,
  partition: false,
  inherits: false,
  columns: [
    column('id', 'int4'),
    column('status'),
    column('created_at', 'timestamptz'),
    column('owner_id', 'uuid'),
  ],
  primary_key: ['id'],
  foreign_key_columns: ['owner_id'],
  checks: [],
  rules: [],
  indexes: [],
  dependencies: [],
  policies: [],
  triggers: [],
  fingerprint: 'a'.repeat(64),
})
describe('bounded declarative job contract', () => {
  it.each(['* * * * *', '*/5 0-23/2 1,15 * 1-5', '0 0 1 1 0'])(
    'accepts numeric minute UTC schedule %s',
    (value) => expect(validSchedule(value)).toBe(true),
  )
  it.each([
    '* * * *',
    '* * * * * *',
    '1 seconds',
    '@daily',
    '60 * * * *',
    '0 24 * * *',
    '0 0 0 * *',
    '*/0 * * * *',
    '3-1 * * * *',
    '* * * * 8',
    '0 0 1 0 *',
  ])('rejects unbounded/invalid schedule %s', (value) =>
    expect(validSchedule(value)).toBe(false),
  )
  it.each([
    'session_token',
    'password_hash',
    'api_key',
    'owner_id',
    'user_id',
    'role',
    'id',
    'permissions',
    'is_superuser',
    'system_role',
    'access_level',
  ])('cannot update privileged column %s', (name) =>
    expect(() =>
      jobManifestEntrySchema.parse({
        ...definition(),
        action: { ...definition().action, set: { [name]: 'value' } },
      }),
    ).toThrow(),
  )
  it('accepts only exact declarative shape, unique bounded manifests and safe filters', () => {
    expect(() =>
      jobsManifestSchema.parse({
        version: 1,
        jobs: [definition(), definition()],
      }),
    ).toThrow()
    expect(() =>
      jobsManifestSchema.parse({
        version: 1,
        jobs: Array.from({ length: 9 }, (_, id) => ({
          ...definition(),
          id: String(id),
        })),
      }),
    ).toThrow()
    expect(() =>
      jobManifestEntrySchema.parse({
        ...definition(),
        sql: 'DELETE FROM tickets',
      }),
    ).toThrow()
    expect(() =>
      jobManifestEntrySchema.parse({
        ...definition(),
        action: {
          ...definition().action,
          where: [{ column: 'session_token', op: 'eq', value: 'x' }],
        },
      }),
    ).toThrow()
    expect(() =>
      jobManifestEntrySchema.parse({
        ...definition(),
        action: { ...definition().action, where: [], limit: 1001 },
      }),
    ).toThrow()
    expect(() =>
      jobsManifestSchema.parse({
        version: 1,
        jobs: Array.from({ length: 8 }, (_, id) => ({
          ...definition(),
          id: String(id),
          action: {
            ...definition().action,
            set: {
              one: 'x'.repeat(2000),
              two: 'x'.repeat(2000),
              three: 'x'.repeat(2000),
            },
          },
        })),
      }),
    ).toThrow(/32KB/)
  })
  it('binds apply/control request shapes with no loose options', () => {
    const base = {
      deviceSecret: 'device-credential-fixture',
      projectId: project,
      expectedRef: 'abc',
      environment: 'development',
      operation: 'cron-apply',
    }
    expect(
      jobsRequestSchema.parse({
        ...base,
        manifest: { version: 1, jobs: [definition()] },
      }).limit,
    ).toBe(50)
    expect(() => jobsRequestSchema.parse(base)).toThrow()
    expect(() =>
      jobsRequestSchema.parse({ ...base, operation: 'cron-pause' }),
    ).toThrow()
    expect(() =>
      jobsRequestSchema.parse({
        ...base,
        operation: 'cron-list',
        manifest: { version: 1, jobs: [definition()] },
      }),
    ).toThrow()
    expect(() =>
      jobsRequestSchema.parse({
        ...base,
        jobId: 'overdue',
        manifest: { version: 1, jobs: [definition()] },
      }),
    ).toThrow()
  })
})
describe('catalog proof and compiled authority', () => {
  it('requires real RLS table, safe columns, PK and supported timestamp filters', () => {
    expect(validateJobTable(definition(), table())).toEqual(table())
    for (const change of [
      { name: 'other' },
      { kind: 'v' },
      { rls: false },
      { partition: true },
      { inherits: true },
      { primary_key: [] },
      { rules: ['CREATE RULE unsafe ...'] },
    ])
      expect(() =>
        validateJobTable(definition(), { ...table(), ...change }),
      ).toThrow()
    for (const change of [
      { type: 'custom', schema: 'public' },
      { generated: 's' },
      { collation_schema: 'public' },
    ])
      expect(() =>
        validateJobTable(definition(), {
          ...table(),
          columns: [...table().columns, { ...column('custom'), ...change }],
        }),
      ).toThrow()
    expect(() =>
      validateJobTable(definition(), {
        ...table(),
        columns: table().columns.filter((c) => c.name !== 'status'),
      }),
    ).toThrow()
    expect(() =>
      validateJobTable(
        {
          ...definition(),
          action: { ...definition().action, set: { owner_id: null } },
        },
        table(),
      ),
    ).toThrow(/ownership/)
    expect(() =>
      validateJobTable(
        {
          ...definition(),
          action: {
            ...definition().action,
            where: [{ column: 'status', op: 'older_than', minutes: 1 }],
          },
        },
        table(),
      ),
    ).toThrow(/data/)
  })
  it('rejects resolved external functions and hidden config changes even for pg_catalog functions', () => {
    expect(() =>
      validateJobTable(definition(), {
        ...table(),
        dependencies: [
          {
            kind: 'function',
            schema: 'public',
            name: 'hidden',
            definition: 'SELECT true',
          },
        ],
      }),
    ).toThrow(/externo/)
    expect(() =>
      validateJobTable(definition(), {
        ...table(),
        indexes: [
          {
            definition: '...',
            method: 'gin',
            expression: null,
            predicate: null,
          },
        ],
      }),
    ).toThrow(/externo/)
    expect(() =>
      validateJobTable(definition(), {
        ...table(),
        checks: ["set_config('role','postgres',true) IS NOT NULL"],
      }),
    ).toThrow()
    expect(() =>
      validateJobTable(definition(), {
        ...table(),
        indexes: [
          {
            definition: '...',
            method: 'btree',
            expression: "set_config('role','postgres',true)",
            predicate: null,
          },
        ],
      }),
    ).toThrow()
    expect(() =>
      validateJobTable(definition(), {
        ...table(),
        policies: [
          {
            name: 'supremo_job_forged',
            roles: [0],
            roles_names: [],
            using: "set_config('role','postgres',true) IS NOT NULL",
            check: null,
          },
        ],
      }),
    ).toThrow()
    expect(() =>
      validateJobTable(definition(), {
        ...table(),
        checks: ["(status = ANY (ARRAY['open'::text, 'overdue'::text]))"],
      }),
    ).not.toThrow()
  })
  it('only permits the exact invoker updated_at trigger with safe search_path', () => {
    const trigger = {
      name: 'update_time',
      internal: false,
      function_schema: 'public',
      function_name: 'set_updated_at',
      language: 'plpgsql',
      definer: false,
      source: 'BEGIN NEW.updated_at = now(); RETURN NEW; END;',
      arguments: 0,
      return_type: 'trigger',
      config: null,
    }
    for (const config of [null, ['search_path=pg_catalog, public']])
      expect(() =>
        validateJobTable(definition(), {
          ...table(),
          triggers: [{ ...trigger, config }],
        }),
      ).not.toThrow()
    for (const change of [
      { config: ['search_path=public, pg_catalog'] },
      { definer: true },
      { source: 'BEGIN RESET ROLE; RETURN NEW; END;' },
    ])
      expect(() =>
        validateJobTable(definition(), {
          ...table(),
          triggers: [{ ...trigger, ...change }],
        }),
      ).toThrow()
    expect(() =>
      validateJobTable(definition(), {
        ...table(),
        triggers: [
          {
            ...trigger,
            internal: true,
            function_schema: 'pg_catalog',
            function_name: 'RI_FKey_check_upd',
            language: 'c',
          },
        ],
      }),
    ).not.toThrow()
  })
  it('compiles values as literals, bounds work and drops privilege before calling immutable SQL', () => {
    const def = {
      ...definition(),
      action: {
        ...definition().action,
        set: {
          status: "x'; RESET ROLE; --",
          score: 3,
          archived: true,
          description: null,
        },
        where: [
          { column: 'status', op: 'neq' as const, value: 'closed' },
          { column: 'id', op: 'eq' as const, value: 1 },
          { column: 'title', op: 'is_null' as const },
          { column: 'updated_at', op: 'not_null' as const },
        ],
      },
    }
    const job = compileJob(project, def, table())
    expect(valueSql(false)).toBe('FALSE')
    expect(quoteLiteral("a\\b'c")).toBe("E'a\\\\b''c'")
    expect(job.body).toContain("E'x''; RESET ROLE; --'")
    expect(job.body).toContain('FOR UPDATE SKIP LOCKED')
    expect(job.body).toContain('LIMIT 100')
    expect(job.body).toContain('IS DISTINCT FROM')
    const sql = runtimeJobSql(project, job)
    expect(sql.indexOf('SET LOCAL ROLE')).toBeGreaterThan(
      sql.indexOf('source_fingerprint') < 0
        ? sql.indexOf('Estrutura da tabela mudou')
        : 0,
    )
    expect(sql).toContain('pg_advisory_xact_lock')
    expect(sql).toContain('pg_catalog.sha256')
    expect(sql).not.toContain('md5')
    expect(sql).toMatch(/^SET LOCAL/)
    expect(sql).not.toMatch(/; COMMIT;$/)
    expect(applyJobsSql(project, [job])).toContain('NOBYPASSRLS NOSUPERUSER')
    expect(applyJobsSql(project, [job])).not.toContain('schedule_in_database')
    expect(() => applyJobsSql(project, [])).toThrow()
    expect(() =>
      applyJobsSql('dfc0ad93-e6f3-4306-b9c7-42186124c180', [job]),
    ).toThrow(/divergente/)
  })
  it('uses owned registry IDs, bounded pages and excludes command/return_message from projections', () => {
    expect(bootstrapJobsSql()).toContain('ENABLE ROW LEVEL SECURITY')
    expect(listJobsSql(project, 10, 20, 'overdue')).toContain(
      'LIMIT 11 OFFSET 20',
    )
    expect(historyJobsSql(project, 10, 0)).not.toContain('return_message')
    expect(historyJobsSql(project, 10, 0)).not.toContain('j.command')
    expect(mutateJobSql(project, 'cron-remove', 'overdue')).toContain(
      'cron.unschedule(m.cron_id)',
    )
    expect(mutateJobSql(project, 'cron-pause', 'overdue')).toContain(
      'active:=false',
    )
    expect(mutateJobSql(project, 'cron-resume', 'overdue')).toContain(
      'active:=true',
    )
    expect(() => listJobsSql(project, 101, 0)).toThrow()
    expect(() => tableCatalogSql('x; DROP TABLE public.tickets')).toThrow()
    expect(tableCatalogSql('tickets')).toContain('pg_catalog.pg_depend')
    expect(tableCatalogSql('tickets')).toContain('0=ANY(p.polroles)')
  })
})
