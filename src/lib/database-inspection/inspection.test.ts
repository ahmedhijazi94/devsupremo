import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  inspectionOptionsSchema,
  inspectionRequestSchema,
  requireReadTarget,
} from './policy'
import { inspectSelectSql, pagedSelectSql, readOnlyTransaction } from './sql'
import {
  boundedJson,
  InspectionError,
  redactInspection,
  supabaseInspectionProvider,
} from './provider'
import { logsParameters, runInspection } from './service'
import { schemaInspectionSql, diagnosticsSql } from './schema'

const options = (extra: Record<string, unknown> = {}) =>
  inspectionOptionsSchema.parse({
    operation: 'inspect',
    expectedRef: 'project-ref',
    environment: 'development',
    ...extra,
  })
afterEach(() => vi.unstubAllGlobals())

describe('project-scoped readonly authority', () => {
  it.each(['development', 'production'] as const)(
    'allows verified %s reads and preserves authority',
    (environment) => {
      const state = requireReadTarget(
        {
          project_ref: 'project-ref',
          environment,
          source: 'supremo_provisioned',
        },
        'project-ref',
        options({ environment }),
      )
      expect(state.environment).toBe(environment)
      expect(state.automaticMigrations).toBe(environment === 'development')
    },
  )
  it('unknown linked database remains unknown and cannot be asserted development', () => {
    expect(
      requireReadTarget(
        null,
        'project-ref',
        options({ environment: 'unknown' }),
      ).environment,
    ).toBe('unknown')
    expect(() => requireReadTarget(null, 'project-ref', options())).toThrow(
      'Vínculo ou ambiente',
    )
    expect(() =>
      requireReadTarget(null, null, options({ environment: 'unknown' })),
    ).toThrow()
    expect(() =>
      requireReadTarget(null, 'other-ref', options({ environment: 'unknown' })),
    ).toThrow()
  })
  it.each([
    { limit: 201 },
    { limit: 0 },
    { limit: 1.5 },
    { offset: 10001 },
    { minutes: 1441 },
    { source: 'arbitrary' },
    { operation: 'query' },
    { sql: 'SELECT 1' },
    { operation: 'logs', table: 'tickets' },
    { table: 'tickets;drop' },
  ])('rejects unsafe options %j', (extra) => {
    expect(() => options(extra)).toThrow()
  })
  it('requires device/project identity and refuses extra authority', () => {
    expect(
      inspectionRequestSchema.safeParse({
        ...options(),
        deviceSecret: 'long-fixture-device',
        projectId: '00000000-0000-4000-8000-000000000001',
      }).success,
    ).toBe(true)
    expect(
      inspectionRequestSchema.safeParse({ ...options(), token: 'client-token' })
        .success,
    ).toBe(false)
  })
})

describe('restricted SQL plus independent database enforcement', () => {
  it.each([
    'SELECT id, title FROM public.tickets ORDER BY created_at DESC',
    "SELECT count(*) AS total FROM public.tickets WHERE status = 'open'",
    "SELECT date_trunc('day', created_at), count(*) FROM public.tickets GROUP BY 1",
    'WITH recent AS (SELECT id FROM public.tickets) SELECT id FROM recent',
    "SELECT coalesce(title, 'no; title'), CASE WHEN status = 'open' THEN 1 ELSE 0 END FROM public.tickets;",
    "SELECT t.id, t.title FROM public.tickets AS t WHERE t.title = 'can''t -- /* comment'",
    'SELECT created_at::date, extract(hour FROM created_at) FROM public.tickets',
    'SELECT pg_catalog.count(*) FROM public.tickets',
    'WITH recent AS (SELECT id FROM public.tickets) SELECT r.id FROM recent AS r',
    'SELECT t.id,p.title FROM public.tickets t,public.projects p WHERE t.id=p.id',
    'SELECT t.id FROM public.tickets t JOIN (SELECT id FROM public.projects) p ON t.id=p.id',
  ])('accepts ordinary bounded data query %s', (sql) => {
    const result = pagedSelectSql(sql, 50, 100)
    expect(result).toContain('LIMIT 51 OFFSET 100')
    expect(result).not.toContain(';;')
  })
  it('resolves allowed functions in pg_catalog, never a public overload by search_path', () => {
    expect(inspectSelectSql('SELECT count(*) FROM public.tickets')).toBe(
      'SELECT pg_catalog.count(*) FROM public.tickets',
    )
    expect(readOnlyTransaction('SELECT 1')).toContain(
      "BEGIN READ ONLY;\nSET LOCAL statement_timeout = '8s'",
    )
    expect(readOnlyTransaction('SELECT 1')).toContain(
      'SET LOCAL search_path = pg_catalog, public',
    )
  })
  it.each([
    'DELETE FROM public.tickets',
    'SELECT 1; COMMIT; DELETE FROM public.tickets',
    'WITH changed AS (DELETE FROM public.tickets RETURNING *) SELECT * FROM changed',
    "SELECT set_config('transaction_read_only', 'off', false)",
    "SELECT public.send_http('https://external.test')",
    "SELECT dblink('other-db','DELETE FROM tickets')",
    'SELECT * FROM auth.users',
    'SELECT * FROM vault.decrypted_secrets',
    'SELECT * FROM pg_authid',
    'SELECT * FROM information_schema.foreign_servers',
    'SELECT * FROM other_schema.hidden',
    'SELECT encrypted_password AS title FROM public.users',
    'SELECT access_token FROM public.integrations',
    'SELECT session_token AS value FROM public.integrations',
    'SELECT password_hash AS value FROM public.integrations',
    'SELECT checksum_hash AS value FROM public.integrations',
    'SELECT authorization AS value FROM public.integrations',
    'SELECT * FROM public.tickets FOR UPDATE',
    "SELECT lo_export(1,'/tmp/leak')",
    'SELECT * INTO public.stolen FROM public.tickets',
    'SELECT CAST(id AS public.custom) FROM public.tickets',
    'SELECT id::public.custom FROM public.tickets',
    'SELECT public.lower(title) FROM public.tickets',
    "SELECT pg_catalog.pg_read_file('/etc/passwd')",
    'SELECT operator(public.+)(1,2)',
    'SELECT $$unterminated',
    "SELECT 'unterminated",
    'SELECT "bad\\name"',
    'SELECT "unterminated',
    'SELECT 1 -- hide',
    'SELECT 1 /* hide */',
    "SELECT E'\\'; COMMIT",
    'SELECT (1',
    'SELECT 1)',
    'SELECT `id` FROM public.tickets',
    'SELECT @x',
    '',
    'SELECT 1;;',
    'SELECT * FROM public.tickets AS private CROSS JOIN private.billing_data',
    'SELECT * FROM public.tickets AS internal JOIN internal.settings ON true',
    'SELECT * FROM public.tickets AS internal, internal.settings',
    'SELECT * FROM public.tickets AS internal WHERE EXISTS(SELECT * FROM internal.settings)',
    'SELECT concat(u) AS result FROM public.users AS u',
    'SELECT array_agg(u)::text FROM public.users AS u',
    'SELECT json_agg(u.*)::text FROM public.users AS u',
    'SELECT concat(x) FROM (SELECT * FROM public.users) AS x',
    'SELECT concat(public.users) FROM public.users',
    'SELECT concat(public) FROM public.users AS public',
    'SELECT "coalesce"(1)',
    'SELECT "extract"(1)',
    'SELECT (SELECT * FROM public.credentials LIMIT 1) AS result',
    "SELECT 'safe' AS result UNION SELECT * FROM public.integrations",
    'SELECT * FROM public.integrations AS coalesce(safe)',
    'SELECT * FROM unqualified_table',
  ])(
    'refuses hidden writes, credential access, session escape and unbounded functions: %s',
    (sql) => {
      expect(() => inspectSelectSql(sql)).toThrow('Consulta recusada')
    },
  )
  it('rejects invalid paging even when directly invoked', () => {
    expect(() => pagedSelectSql('SELECT 1', Infinity, 0)).toThrow()
    expect(() => schemaInspectionSql(201, 0)).toThrow()
    expect(() => schemaInspectionSql(50, 0, "x';drop")).toThrow()
  })
})

describe('bounded project provider with honest errors', () => {
  it('uses only the restricted endpoint, timeout, no redirects and fresh server credentials', async () => {
    const resolve = vi.fn(async () => ({
      projectRef: 'project-ref',
      token: 'server-only-value',
    }))
    const fetcher = vi.fn(async () => Response.json([{ total: 3 }]))
    vi.stubGlobal('fetch', fetcher)
    const provider = supabaseInspectionProvider(resolve)
    expect(await provider.query('SELECT 3 AS total')).toEqual([{ total: 3 }])
    await provider.query('SELECT 4')
    expect(resolve).toHaveBeenCalledTimes(2)
    expect(fetcher).toHaveBeenCalledWith(
      'https://api.supabase.com/v1/projects/project-ref/database/query/read-only',
      expect.objectContaining({
        redirect: 'error',
        cache: 'no-store',
        signal: expect.any(AbortSignal),
        body: JSON.stringify({
          query: readOnlyTransaction('SELECT 3 AS total'),
        }),
      }),
    )
  })
  it.each([401, 403, 404, 405, 402, 429, 500, 400])(
    'fails HTTP %i explicitly without falling back or exposing provider text',
    async (status) => {
      const fetcher = vi.fn(
        async () => new Response('secret=provider-private-value', { status }),
      )
      vi.stubGlobal('fetch', fetcher)
      const provider = supabaseInspectionProvider(async () => ({
        projectRef: 'project-ref',
        token: 'token',
      }))
      await expect(provider.query('SELECT 1')).rejects.toThrow(`HTTP ${status}`)
      expect(fetcher).toHaveBeenCalledTimes(1)
    },
  )
  it('refuses invalid refs before any fetch, unexpected SQL shape, bad logs, interrupted and invalid JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ unexpected: true })),
    )
    await expect(
      supabaseInspectionProvider(async () => ({
        projectRef: '../other',
        token: 'token',
      })).query('SELECT 1'),
    ).rejects.toThrow('Vínculo')
    expect(fetch).not.toHaveBeenCalled()
    const provider = supabaseInspectionProvider(async () => ({
      projectRef: 'project-ref',
      token: 'token',
    }))
    await expect(provider.query('SELECT 1')).rejects.toThrow(
      'Resposta SQL inesperada',
    )
    await expect(provider.logs(new URLSearchParams())).rejects.toThrow(
      'Logs indisponíveis',
    )
    vi.mocked(fetch).mockResolvedValue(
      Response.json({ result: [], error: 'provider details secret=value' }),
    )
    await expect(provider.logs(new URLSearchParams())).rejects.toThrow(
      'Logs indisponíveis',
    )
    vi.mocked(fetch).mockRejectedValue(new Error('sensitive network details'))
    await expect(provider.query('SELECT 1')).rejects.toThrow('não respondeu')
    vi.mocked(fetch).mockResolvedValue(new Response('{broken'))
    await expect(provider.query('SELECT 1')).rejects.toThrow('JSON inválido')
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error('cut'))
          },
        }),
      ),
    )
    await expect(provider.query('SELECT 1')).rejects.toThrow('interrompida')
  })
  it('caps bodies while streaming, independent of Content-Length', async () => {
    await expect(boundedJson(new Response('12345'), 4)).rejects.toThrow(
      'excedeu',
    )
    await expect(
      boundedJson(
        new Response('12345', { headers: { 'content-length': '5' } }),
        4,
      ),
    ).rejects.toThrow('excedeu')
    await expect(boundedJson(new Response(null))).rejects.toThrow('vazia')
    expect(await boundedJson(Response.json({ real: 1 }))).toEqual({ real: 1 })
  })
  it('recursively removes credential columns, diagnostic tokens and actual device/provider secrets', () => {
    const response = redactInspection(
      [
        {
          title: 'Real ticket',
          password: 'pass',
          meta: {
            authorization: 'bearer',
            nested: ['device-secret', 'server-secret', null, 1, true],
          },
          url: 'https://user:pass@host.test/x?q=secret',
          message: 'token=private',
        },
      ],
      ['device-secret', 'server-secret'],
    )
    expect(response.redacted).toBe(true)
    expect(JSON.stringify(response.value)).toContain('Real ticket')
    for (const secret of [
      '"pass"',
      'bearer',
      'device-secret',
      'server-secret',
      'q=secret',
      'private',
    ])
      expect(JSON.stringify(response.value)).not.toContain(secret)
    expect(redactInspection('x'.repeat(8001)).truncated).toBe(true)
    expect(
      redactInspection(Array.from({ length: 201 }, () => 1)).truncated,
    ).toBe(true)
    expect(
      redactInspection(
        Object.fromEntries(
          Array.from({ length: 201 }, (_, i) => [`key${i}`, 1]),
        ),
      ).truncated,
    ).toBe(true)
    let nested: unknown = 1
    for (let i = 0; i < 14; i++) nested = { nested }
    expect(redactInspection(nested).truncated).toBe(true)
  })
})

describe('schema, real rows and diagnostic evidence contract', () => {
  it('returns columns and honest pagination, row cap and source labels', async () => {
    const provider = {
      query: vi.fn(async () => [
        { id: 1, title: 'first' },
        { id: 2, title: 'second' },
      ]),
      logs: vi.fn(async () => []),
    }
    const result = await runInspection(
      provider,
      options({
        operation: 'query',
        sql: 'SELECT id,title FROM public.tickets',
        limit: 1,
      }),
    )
    expect(result).toMatchObject({
      rowCount: 1,
      columns: ['id', 'title'],
      hasMore: true,
      nextOffset: 1,
      truncated: true,
      redacted: false,
    })
    expect(provider.query).toHaveBeenCalledWith(
      expect.stringContaining('LIMIT 2 OFFSET 0'),
    )
  })
  it('discloses nested schema limits and public relations including views, columns, PK/FK/index/RLS/policies', async () => {
    const provider = {
      query: vi.fn(async () => [{ name: 'tickets', columns_count: 101 }]),
      logs: vi.fn(async () => []),
    }
    const result = await runInspection(provider, options({ table: 'tickets' }))
    expect(result).toMatchObject({
      schema: 'public',
      nestedLimit: 100,
      truncated: true,
      approximateRowCounts: true,
    })
    const query = schemaInspectionSql(50, 0, 'tickets')
    for (const word of [
      'view',
      'columns',
      'foreign_keys',
      'indexes',
      'policies',
      'rls_enabled',
      "c.relname='tickets'",
    ])
      expect(query).toContain(word)
    expect(diagnosticsSql).toContain('transaction_read_only')
  })
  it('uses fixed logs projection, source enum and <=24h time window; no raw client log SQL', async () => {
    const parameters = logsParameters(
      options({
        operation: 'logs',
        source: 'auth',
        level: 'error',
        minutes: 1440,
        limit: 2,
      }),
      new Date('2026-09-07T00:00:00Z'),
    )
    expect(parameters.get('sql')).toContain("source = 'auth_logs'")
    expect(parameters.get('sql')).toContain('positionCaseInsensitive')
    expect(parameters.get('sql')).not.toContain('log_attributes')
    expect(parameters.get('iso_timestamp_start')).toBe(
      '2026-09-06T00:00:00.000Z',
    )
    const provider = {
      query: vi.fn(async () => []),
      logs: vi.fn(async () => [
        { event_message: 'Error: denied', timestamp: 'real-time' },
      ]),
    }
    expect(
      await runInspection(
        provider,
        options({ operation: 'logs', level: 'error' }),
      ),
    ).toMatchObject({
      rowCount: 1,
      source: 'postgres',
      errorFilter: 'message_contains_error_or_fatal',
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ result: [{ event_message: 'real' }], error: null }),
      ),
    )
    expect(
      await supabaseInspectionProvider(async () => ({
        projectRef: 'project-ref',
        token: 'token',
      })).logs(parameters),
    ).toEqual([{ event_message: 'real' }])
  })
  it('report never converts permission failures into empty success', async () => {
    const provider = {
      query: vi.fn(async () => [{ total: 1 }]),
      logs: vi.fn(async (): Promise<unknown[]> => {
        throw new InspectionError('Sem permissão (HTTP 403).')
      }),
    }
    const result = await runInspection(
      provider,
      options({ operation: 'report' }),
    )
    expect(result).toMatchObject({
      complete: false,
      sections: {
        structure: { status: 'ok' },
        diagnostics: { status: 'ok' },
        logs: { status: 'unavailable', error: expect.stringContaining('403') },
      },
    })
    provider.logs.mockRejectedValue(new Error('credentials-in-error'))
    expect(
      JSON.stringify(
        await runInspection(provider, options({ operation: 'report' })),
      ),
    ).not.toContain('credentials-in-error')
    provider.logs.mockResolvedValue([])
    expect(
      await runInspection(provider, options({ operation: 'report' })),
    ).toMatchObject({ complete: true })
    provider.query.mockResolvedValue([{ total: 1 }, { total: 2 }])
    expect(
      await runInspection(provider, options({ operation: 'report', limit: 1 })),
    ).toMatchObject({ complete: false, available: true })
  })
  it('stops pagination at the maximum offset and permits empty confirmed results', async () => {
    const provider = {
      query: vi.fn(async () => [{ id: 1 }, { id: 2 }]),
      logs: vi.fn(async () => []),
    }
    expect(
      await runInspection(
        provider,
        options({
          operation: 'query',
          sql: 'SELECT 1',
          offset: 10000,
          limit: 1,
        }),
      ),
    ).toMatchObject({ hasMore: true, nextOffset: null })
    provider.query.mockResolvedValue([])
    expect(await runInspection(provider, options())).toMatchObject({
      rowCount: 0,
      hasMore: false,
      truncated: false,
    })
  })
})
