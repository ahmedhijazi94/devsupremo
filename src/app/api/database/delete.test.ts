import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { POST } from './route'
import { authenticateDeviceSecret } from '@/lib/checkpoint/devices'
import { getProject } from '@/lib/projects/repository'
import { readEnvironment } from '@/lib/database-environment/store'
import { runAuthorizedDelete } from '@/lib/database-delete/server'
import { DataDeleteError, DataDeleteOperationError } from '@/lib/database-delete/contract'
vi.mock('@/lib/supabase/admin', () => ({ createServiceClient: () => ({}) }))
vi.mock('@/lib/checkpoint/store', () => ({ supabaseCheckpointDeviceStore: () => ({}) }))
vi.mock('@/lib/checkpoint/devices', () => ({ authenticateDeviceSecret: vi.fn() }))
vi.mock('@/lib/projects/repository', () => ({ getProject: vi.fn(), getSupabaseCredentials: vi.fn() }))
vi.mock('@/lib/database-environment/store', () => ({ readEnvironment: vi.fn() }))
vi.mock('@/lib/database-delete/server', () => ({ runAuthorizedDelete: vi.fn() }))
const projectId = '00000000-0000-4000-8000-000000000001'
const base = { deviceSecret: 'test-device-secret', projectId, expectedRef: 'dev-ref', environment: 'development', operation: 'data-delete-plan', targets: [{ table: 'orgs', key: { id: 'row' } }] }
const request = (extra = {}) => new NextRequest('https://supremo.test/api/database', { method: 'POST', body: JSON.stringify({ ...base, ...extra }) })
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(authenticateDeviceSecret).mockResolvedValue({ ok: true, device: { id: 'device', ownerUserId: 'owner', revokedAt: null, label: null } })
  vi.mocked(getProject).mockResolvedValue({ id: projectId, supabase_project_ref: 'dev-ref' } as Awaited<ReturnType<typeof getProject>>)
  vi.mocked(readEnvironment).mockResolvedValue({ environment: 'development', source: 'supremo_provisioned', project_ref: 'dev-ref' })
  vi.mocked(runAuthorizedDelete).mockResolvedValue({ data: { planToken: 'opaque' } } as never)
})
describe('typed deletion device API', () => {
  it('passes authenticated owner and revalidation callback, no client authority', async () => {
    const response = await POST(request())
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const [authority, options] = vi.mocked(runAuthorizedDelete).mock.calls[0]!
    expect(authority).toMatchObject({ ownerId: 'owner', projectId, expectedRef: 'dev-ref' })
    expect(options).not.toHaveProperty('deviceSecret')
    expect(await authority.verifyIdentity()).toBe('owner')
    vi.mocked(authenticateDeviceSecret).mockResolvedValue({ ok: false, reason: 'revoked' })
    await expect(authority.verifyIdentity()).rejects.toThrow('Dispositivo')
  })
  it('rejects unknown authority, SQL, production and revoked devices', async () => {
    for (const extra of [{ ownerId: 'spoof' }, { sql: 'delete from orgs' }, { environment: 'production' }]) expect((await POST(request(extra))).status).toBe(400)
    vi.mocked(authenticateDeviceSecret).mockResolvedValue({ ok: false, reason: 'revoked' })
    expect((await POST(request())).status).toBe(401)
    expect(runAuthorizedDelete).not.toHaveBeenCalled()
  })
  it('returns safe actionable errors with no provider detail', async () => {
    vi.mocked(runAuthorizedDelete).mockRejectedValueOnce(new DataDeleteError('Plano expirado.', 409))
    expect(await (await POST(request())).json()).toEqual({ error: 'Plano expirado.' })
    vi.mocked(runAuthorizedDelete).mockRejectedValueOnce(new Error('private secret'))
    expect(JSON.stringify(await (await POST(request())).json())).not.toContain('private secret')
  })
  it.each(['uncertain', 'running', 'failed'] as const)('returns the remote operation ID and %s outcome without losing its classification', async operationState => {
    const operationId = '00000000-0000-4000-8000-000000000090'
    vi.mocked(runAuthorizedDelete).mockRejectedValueOnce(new DataDeleteOperationError(operationId, operationState))
    const response = await POST(request({ operation: 'data-delete-apply', targets: undefined, planToken: 'signed-fixture'.repeat(8), authorization: 'Excluir o registro solicitado.' }))
    expect(response.status).toBe(409)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toMatchObject({ code: operationState === 'failed' ? 'operation_failed' : 'operation_uncertain', operationId, operationState })
  })
})
