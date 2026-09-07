import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { computeChangesetSha256, sha256Hex, type Changeset } from '@/lib/checkpoint/changeset'
import { hashDeviceSecret } from '@/lib/checkpoint/devices'

const boundary = vi.hoisted(() => ({ client: null as unknown, externalCall: vi.fn() }))
vi.mock('@/lib/supabase/admin', () => ({ createServiceClient: () => boundary.client }))
vi.mock('@/lib/github/app', () => ({
  appTokenForRepo: boundary.externalCall, installationCreds: boundary.externalCall,
  mintRepoScopedToken: boundary.externalCall, revokeInstallationToken: boundary.externalCall,
}))
import { POST } from './route'

const projectId = '11111111-1111-4111-8111-111111111111'
const checkpointId = '22222222-2222-4222-8222-222222222222'
const secret = 'sup_dev_ckpt_fixture_secret'
const sha = 'a'.repeat(40)
type Row = Record<string, unknown>

/** Execute real auth, grant, integrity and checkpoint reads against row filters. */
function memoryDatabase() {
  const checkpoint: Row = { id: checkpointId, project_id: projectId, commit_sha: sha,
    push_status: 'published', pr_number: 42, published_sha: 'b'.repeat(40) }
  const tables: Record<string, Row[]> = {
    checkpoint_devices: [{ id: 'device-a', owner_user_id: 'owner-a', secret_hash: hashDeviceSecret(secret), revoked_at: null }],
    projects: [{ id: projectId, user_id: 'owner-a', github_repo_full_name: 'team/app', default_branch: 'main' }],
    checkpoints: [checkpoint],
  }
  const reads: string[] = []
  const client = {
    from(table: string) {
      const filters: Array<[string, unknown]> = []
      let patch: Row | null = null
      const execute = () => {
        if (!patch) reads.push(table)
        const row = tables[table]?.find((item) => filters.every(([column, value]) => item[column] === value)) ?? null
        if (patch && row) Object.assign(row, patch)
        return { data: row, error: null }
      }
      const query = {
        select: () => query,
        eq: (column: string, value: unknown) => { filters.push([column, value]); return query },
        update: (value: Row) => { patch = value; return query },
        maybeSingle: async () => execute(),
        then: (resolve: (value: ReturnType<typeof execute>) => void) => resolve(execute()),
      }
      return query
    },
  } as unknown as SupabaseClient
  return { client, checkpoint, reads }
}

function request(commitSha = sha): NextRequest {
  const content = 'export const title = "Chamados"'
  const changeset: Changeset = {
    checkpointId, commitSha, parentCheckpointId: null, message: 'Mostre a data de criação',
    authorName: 'Fixture', authorEmail: 'fixture@example.invalid',
    files: [{ path: 'src/tickets.ts', op: 'add', contentBase64: Buffer.from(content).toString('base64'), sha256: sha256Hex(content) }],
  }
  return new NextRequest('http://localhost/api/checkpoint/publish', { method: 'POST', body: JSON.stringify({
    projectId, deviceSecret: secret, changeset, changesetSha256: computeChangesetSha256(changeset), summary: changeset.message,
  }) })
}

let database: ReturnType<typeof memoryDatabase>
beforeEach(() => {
  database = memoryDatabase()
  boundary.client = database.client
  boundary.externalCall.mockReset().mockImplementation(() => { throw new Error('Unexpected external publication') })
})

describe('checkpoint publication identity', () => {
  it.each(['published', 'integrated'])('replays the same %s checkpoint and SHA without republishing', async (status) => {
    database.checkpoint.push_status = status
    const response = await POST(request())
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ prNumber: 42, published: true, idempotent: true })
    expect(boundary.externalCall).not.toHaveBeenCalled()
  })

  it.each(['publishing', 'published', 'integrated', 'failed'])('refuses a different SHA for the same %s checkpoint before external writes', async (status) => {
    database.checkpoint.push_status = status
    const response = await POST(request('c'.repeat(40)))
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ reason: 'checkpoint_sha_mismatch' })
    expect(database.checkpoint).toMatchObject({ commit_sha: sha, push_status: status, published_sha: 'b'.repeat(40) })
    expect(boundary.externalCall).not.toHaveBeenCalled()
  })

  it.each(['abcdef0', 'x'.repeat(40), 'a'.repeat(41)])('refuses incomplete or invalid local revision %s before privileged reads', async (revision) => {
    expect((await POST(request(revision))).status).toBe(400)
    expect(database.reads).toEqual([])
    expect(boundary.externalCall).not.toHaveBeenCalled()
  })
})
