import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { hashDeviceSecret } from '@/lib/checkpoint/devices'
import { buildValidationFeedback, type ValidationFeedback } from '@/lib/checkpoint/feedback'
import { saveCheckpointFeedback } from '@/lib/checkpoint/feedback-store'
import { backendTurnContextSchema, type BackendTurnContext } from '@/lib/checkpoint/turn-context'
import { acceptanceFixture } from '@/test/fixtures/acceptance'

const backend = vi.hoisted(() => ({ client: null as unknown }))
vi.mock('@/lib/supabase/admin', () => ({ createServiceClient: () => backend.client }))
import { POST } from './route'

const projectId = '11111111-1111-4111-8111-111111111111'
const otherProjectId = '33333333-3333-4333-8333-333333333333'
const secret = 'sup_dev_ckpt_test_device_secret'
const ownerId = 'owner-a'
type Row = Record<string, unknown>

/**
 * Stateful PostgREST boundary, not a queue of canned return values. Real auth,
 * owner resolution, environment policy, feedback persistence and latest-query
 * code run together; this adapter implements their filtering/CAS semantics.
 */
function memoryDatabase() {
  const tables: Record<string, Row[]> = {
    checkpoint_devices: [{ id: 'device-a', secret_hash: hashDeviceSecret(secret), owner_user_id: ownerId, revoked_at: null }],
    projects: [
      { id: projectId, user_id: ownerId, name: 'Chamados', github_repo_full_name: 'team/chamados', active_branch: 'feature/work', default_branch: 'main', supabase_project_ref: 'dev-ref', access_token: 'private-project-token' },
      { id: otherProjectId, user_id: 'owner-b', name: 'Private project', github_repo_full_name: 'other/private', default_branch: 'main', supabase_project_ref: 'other-ref' },
    ],
    project_database_environments: [{ project_id: projectId, project_ref: 'dev-ref', environment: 'development', source: 'supremo_provisioned' }],
    checkpoints: [],
  }
  const reads: Array<{ table: string; columns: string }> = []
  const unavailable = new Set<string>()
  let beforeRead: ((table: string, columns: string) => void) | null = null
  const client = {
    from(table: string) {
      const filters: Array<(row: Row) => boolean> = []
      let columns = ''
      let orderColumn = ''
      let ascending = true
      let maximum = Infinity
      let patch: Row | null = null
      const execute = () => {
        if (!patch) {
          reads.push({ table, columns })
          beforeRead?.(table, columns)
        }
        if (unavailable.has(table)) return { data: null, error: { message: 'password=private-database-error' } }
        let matching = (tables[table] ?? []).filter((row) => filters.every((filter) => filter(row)))
        if (orderColumn) matching = [...matching].sort((left, right) => String(left[orderColumn]).localeCompare(String(right[orderColumn])) * (ascending ? 1 : -1))
        matching = matching.slice(0, maximum)
        if (patch) for (const row of matching) Object.assign(row, patch)
        return { data: matching[0] ?? null, error: null }
      }
      const chain = {
        select(value: string) { columns = value; return chain },
        eq(column: string, value: unknown) { filters.push((row) => row[column] === value); return chain },
        in(column: string, values: unknown[]) { filters.push((row) => values.includes(row[column])); return chain },
        not(column: string, operator: string, value: unknown) {
          if (operator !== 'is' || value !== null) throw new Error('Unsupported test filter')
          filters.push((row) => row[column] != null)
          return chain
        },
        order(column: string, options: { ascending: boolean }) { orderColumn = column; ascending = options.ascending; return chain },
        limit(value: number) { maximum = value; return chain },
        update(value: Row) { patch = value; return chain },
        or(value: string) {
          const timestamp = value.replace('validation_feedback.is.null,validation_feedback->>observedAt.lt.', '')
          filters.push((row) => row.validation_feedback == null || String((row.validation_feedback as Row).observedAt) < timestamp)
          return chain
        },
        maybeSingle: async () => execute(),
        then: (resolve: (result: ReturnType<typeof execute>) => void) => resolve(execute()),
      }
      return chain
    },
  } as unknown as SupabaseClient
  return { client, tables, reads, unavailable, onRead: (callback: typeof beforeRead) => { beforeRead = callback } }
}

function checkpoint(index = 1, project = projectId): Row {
  return {
    id: `22222222-2222-4222-8222-${String(index).padStart(12, '0')}`,
    project_id: project,
    commit_sha: index.toString(16).padStart(40, '0'),
    published_sha: (index + 10).toString(16).padStart(40, '0'),
    push_status: 'published',
    integration_status: 'ci_running',
    integration_branch: 'supremo/cp-work',
    created_at: `2026-09-06T01:${String(index).padStart(2, '0')}:00.000Z`,
    validation_feedback: null, validation_failure: null, validation_success: null,
  }
}
function feedback(row: Row, state: ValidationFeedback['state'] = 'failed', observedAt = '2026-09-06T02:00:00.000Z'): ValidationFeedback {
  return buildValidationFeedback({
    projectId: String(row.project_id), checkpointId: String(row.id), commitSha: String(row.commit_sha), publishedSha: String(row.published_sha),
    checksSha: String(row.published_sha), observedAt,
    required: ['auth isolation'], integrated: state === 'integrated',
    checks: [{ name: 'auth isolation', status: state === 'pending' ? 'in_progress' : 'completed', conclusion: state === 'failed' ? 'failure' : state === 'pending' ? null : 'success' }],
    evidence: 'B cannot access tickets owned by A. token=private-token\ncookie=private-cookie',
  })
}
const request = (body: unknown = { projectId, deviceSecret: secret }) => new Request('http://localhost/api/checkpoint/turn-context', { method: 'POST', body: JSON.stringify(body) })
let database: ReturnType<typeof memoryDatabase>
beforeEach(() => {
  database = memoryDatabase()
  backend.client = database.client
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Turn preflight must not call external services') }))
})
afterEach(() => { vi.unstubAllGlobals() })
async function context(): Promise<BackendTurnContext> {
  const response = await POST(request())
  expect(response.status).toBe(200)
  expect(response.headers.get('Cache-Control')).toBe('no-store')
  return backendTurnContextSchema.parse(await response.json())
}

describe('turn preflight backend reconciliation', () => {
  it('rejects malformed input, unknown fields and oversized credentials before database access', async () => {
    for (const payload of [{ projectId: 'bad' }, { projectId, deviceSecret: secret, environment: 'development' }, { projectId, deviceSecret: 'x'.repeat(257) }]) {
      expect((await POST(request(payload))).status).toBe(400)
    }
    expect(database.reads).toEqual([])
  })

  it.each(['revoked', 'unknown'])('rejects %s devices before reading any project data', async (kind) => {
    if (kind === 'revoked') database.tables.checkpoint_devices![0]!.revoked_at = '2026-09-06T00:00:00.000Z'
    else database.tables.checkpoint_devices = []
    expect((await POST(request())).status).toBe(401)
    expect(database.reads.every((read) => read.table === 'checkpoint_devices')).toBe(true)
  })

  it('isolates two projects before privileged environment or checkpoint reads', async () => {
    const privateCheckpoint = checkpoint(9, otherProjectId)
    database.tables.checkpoints!.push(privateCheckpoint)
    await saveCheckpointFeedback(database.client, feedback(privateCheckpoint))
    const unauthorized = await POST(request({ projectId: otherProjectId, deviceSecret: secret }))
    expect(unauthorized.status).toBe(403)
    expect(database.reads.some((read) => read.table === 'checkpoints' || read.table === 'project_database_environments')).toBe(false)
    expect(await unauthorized.text()).not.toContain('Private project')
    const own = await context()
    expect(own.latestCheckpoint).toBeNull()
    expect(own.feedback).toEqual({ current: null, previousFailure: null })
  })

  it('delivers a persisted remote failure to a cold turn without local daemon state or GitHub calls', async () => {
    const row = checkpoint()
    database.tables.checkpoints!.push(row)
    await saveCheckpointFeedback(database.client, feedback(row))
    const result = await context()
    expect(result).toMatchObject({ projectId, project: { id: projectId, name: 'Chamados' },
      repository: { fullName: 'team/chamados', branch: 'feature/work' }, databaseEnvironment: 'development',
      databaseAuthority: { projectRef: 'dev-ref', automaticMigrations: true, source: 'supremo_provisioned' },
      latestCheckpoint: { id: row.id, localSha: row.commit_sha, publishedSha: row.published_sha },
      feedback: { current: { checkpointId: row.id, state: 'failed' }, previousFailure: null },
    })
    expect(JSON.stringify(result)).not.toMatch(/private-token|private-cookie|private-project-token|device_secret/)
    expect(fetch).not.toHaveBeenCalled()
  })
  it('delivers named acceptance proof from persistence on a cold turn with its exact published revision', async () => {
    const row = checkpoint()
    database.tables.checkpoints!.push(row)
    const acceptance = { ...acceptanceFixture, sha: String(row.published_sha) }
    await saveCheckpointFeedback(database.client, { ...feedback(row, 'passed'), acceptance })
    expect((await context()).feedback.current?.acceptance).toEqual(acceptance)
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each(['production', 'missing', 'mismatch'])('fails closed for %s database authority while still returning recovery', async (kind) => {
    if (kind === 'missing') database.tables.project_database_environments = []
    else if (kind === 'mismatch') database.tables.project_database_environments![0]!.project_ref = 'wrong-ref'
    else database.tables.project_database_environments![0]!.environment = 'production'
    const result = await context()
    expect(result.databaseEnvironment).toBe(kind === 'production' ? 'production' : 'unknown')
    expect(result.databaseAuthority.automaticMigrations).toBe(false)
    if (kind !== 'production') expect(result.databaseAuthority.source).toBeNull()
  })

  it('requires a provisioned repository and never authorizes a client-provided repository', async () => {
    database.tables.projects![0]!.github_repo_full_name = null
    expect((await POST(request())).status).toBe(409)
    expect(database.reads.some((read) => read.table === 'checkpoints')).toBe(false)
  })

  it('keeps a failed predecessor while its successor validates, and clears it only after persisted success', async () => {
    const older = checkpoint(1)
    const newer = checkpoint(2)
    database.tables.checkpoints!.push(older, newer)
    await saveCheckpointFeedback(database.client, feedback(older))
    await saveCheckpointFeedback(database.client, feedback(newer, 'pending'))
    expect((await context()).feedback).toMatchObject({ current: { checkpointId: newer.id, state: 'pending' }, previousFailure: { checkpointId: older.id, state: 'failed' } })
    await saveCheckpointFeedback(database.client, feedback(newer, 'passed', '2026-09-06T03:00:00.000Z'))
    expect((await context()).feedback).toMatchObject({ current: { checkpointId: newer.id, state: 'passed' }, previousFailure: null })
    database.tables.checkpoints!.push(checkpoint(3))
    expect((await context()).feedback).toEqual({ current: null, previousFailure: null })
  })

  it('ignores late observations for the same checkpoint and never applies old failure as the current SHA', async () => {
    const older = checkpoint(1)
    const newer = checkpoint(2)
    database.tables.checkpoints!.push(older, newer)
    await saveCheckpointFeedback(database.client, feedback(newer, 'passed', '2026-09-06T03:00:00.000Z'))
    await saveCheckpointFeedback(database.client, feedback(newer, 'failed', '2026-09-06T02:00:00.000Z'))
    await saveCheckpointFeedback(database.client, feedback(older, 'failed', '2026-09-06T04:00:00.000Z'))
    expect((await context()).feedback).toMatchObject({ current: { checkpointId: newer.id, publishedSha: newer.published_sha, state: 'passed' }, previousFailure: null })
  })

  it('rereads the checkpoint after a concurrent publication instead of mixing A feedback with B identity', async () => {
    const older = checkpoint(1)
    const newer = checkpoint(2)
    database.tables.checkpoints!.push(older)
    await saveCheckpointFeedback(database.client, feedback(older))
    database.onRead((table, columns) => {
      if (table === 'checkpoints' && columns.endsWith('validation_feedback')) {
        database.onRead(null)
        database.tables.checkpoints!.push(newer)
      }
    })
    const result = await context()
    expect(result.latestCheckpoint?.id).toBe(newer.id)
    expect(result.feedback).toMatchObject({ current: null, previousFailure: { checkpointId: older.id, state: 'failed' } })
  })

  it('bounds reconciliation retries when publications keep overtaking the read', async () => {
    database.tables.checkpoints!.push(checkpoint(1))
    let next = 2
    database.onRead((table, columns) => {
      if (table === 'checkpoints' && columns.endsWith('validation_feedback')) database.tables.checkpoints!.push(checkpoint(next++))
    })
    expect((await POST(request())).status).toBe(409)
    expect(next).toBe(5)
  })

  it.each(['projects', 'project_database_environments', 'checkpoints'])('preserves unknown/error semantics during %s outage and reconciles after reconnect', async (table) => {
    const row = checkpoint()
    database.tables.checkpoints!.push(row)
    await saveCheckpointFeedback(database.client, feedback(row))
    database.unavailable.add(table)
    const response = await POST(request())
    expect(response.status).toBe(503)
    expect(await response.text()).not.toContain('private-database-error')
    database.unavailable.clear()
    expect((await context()).feedback.current?.state).toBe('failed')
  })

  it('refuses mismatched SHA evidence without silently clearing the pending failure', async () => {
    const row = checkpoint()
    database.tables.checkpoints!.push(row)
    await saveCheckpointFeedback(database.client, feedback(row))
    row.validation_feedback = { ...feedback(row), publishedSha: 'f'.repeat(40) }
    expect((await POST(request())).status).toBe(503)
    expect(row.validation_failure).toMatchObject({ state: 'failed' })
  })

  it.each(['ci_failed', 'security_blocked'])('never returns a clean turn when %s is known before detailed feedback arrives', async (integrationStatus) => {
    const row = checkpoint()
    row.integration_status = integrationStatus
    database.tables.checkpoints!.push(row)
    expect((await POST(request())).status).toBe(503)
    await saveCheckpointFeedback(database.client, feedback(row, 'pending'))
    expect((await POST(request())).status).toBe(503)
    await saveCheckpointFeedback(database.client, feedback(row, 'failed', '2026-09-06T03:00:00.000Z'))
    expect((await context()).feedback.current).toMatchObject({ checkpointId: row.id, state: 'failed' })
  })
})
