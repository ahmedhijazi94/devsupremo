import { beforeEach, expect, it, vi } from 'vitest'
import { OperationError } from '@/lib/backend-operations/contract'

const mocks = vi.hoisted(() => ({ authenticate: vi.fn(), authorize: vi.fn(), project: vi.fn(), credentials: vi.fn(), head: vi.fn(), tree: vi.fn(), read: vi.fn(), plan: vi.fn() }))
vi.mock('@/lib/supabase/admin', () => ({ createServiceClient: () => ({}) }))
vi.mock('@/lib/checkpoint/devices', () => ({ authenticateDeviceSecret: mocks.authenticate }))
vi.mock('@/lib/checkpoint/store', () => ({ supabaseCheckpointDeviceStore: () => ({}) }))
vi.mock('@/lib/backend-operations/server', () => ({ authorizeProjectOperation: mocks.authorize }))
vi.mock('@/lib/projects/repository', () => ({ getProject: mocks.project, getGithubCredentials: mocks.credentials }))
vi.mock('@/lib/github/client', () => ({ getHeadSha: mocks.head, listTree: mocks.tree, readFile: mocks.read }))
vi.mock('@/lib/templates/sync', () => ({ planTemplateSync: mocks.plan }))
vi.mock('@/lib/bootstrap/cli-artifact', () => ({ cliArtifact: () => ({ digest: 'a'.repeat(64) }) }))
import { POST } from './route'

const projectId = '11111111-1111-4111-8111-111111111111', ownerId = '22222222-2222-4222-8222-222222222222', deviceId = '33333333-3333-4333-8333-333333333333'
const body = { projectId, deviceSecret: 'test-device-secret', operation: 'prepare' }
const post = (input = body) => POST(new Request('https://supremo.example/api/cli/candidate', { method: 'POST', body: JSON.stringify(input) }))
beforeEach(() => {
  vi.resetAllMocks()
  mocks.authenticate.mockResolvedValue({ ok: true, device: { id: deviceId, ownerUserId: ownerId } })
  mocks.authorize.mockResolvedValue({ revision: deviceId })
  mocks.project.mockResolvedValue({ id: projectId, name: 'Fixture', kind: 'solo', template_version: '4.0.18' })
  mocks.credentials.mockResolvedValue({ defaultBranch: 'main', branch: 'main' }); mocks.head.mockResolvedValue('b'.repeat(40))
  mocks.tree.mockResolvedValue([{ path: 'scripts/verify.mjs', sha: 'c'.repeat(40) }])
  mocks.plan.mockResolvedValue({ templateVersion: '4.0.18', creates: [{ path: 'app/page.tsx', content: 'application code' }],
    updates: [{ path: 'scripts/verify.mjs', content: 'verified engine' }, { path: 'tools/supremo-cli/dist/bin.js', content: 'separate tarball' }] })
})
it('pins the repository snapshot and emits only allowed tooling with its expected prior blob', async () => {
  const response = await post()
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ projectId, baseSha: 'b'.repeat(40), cliDigest: 'a'.repeat(64),
    files: [{ path: 'scripts/verify.mjs', beforeBlob: 'c'.repeat(40), content: 'verified engine' }] })
  expect(mocks.plan).toHaveBeenCalledWith(expect.objectContaining({ defaultBranch: 'b'.repeat(40), branch: 'b'.repeat(40) }), expect.objectContaining({ projectId }))
  expect(mocks.authorize).toHaveBeenCalledTimes(2)
  expect(mocks.authorize).toHaveBeenCalledWith(expect.objectContaining({ ownerId, projectId, deviceId, environment: 'development' }), 'engine.update', { resource: 'engine.tools' })
  expect(response.headers.get('Cache-Control')).toBe('no-store')
})
it('never retrieves repository credentials for an untrusted device or refused policy', async () => {
  mocks.authenticate.mockResolvedValueOnce({ ok: false })
  expect((await post()).status).toBe(401)
  mocks.authorize.mockRejectedValueOnce(new OperationError('Sem permissão.', 403))
  expect((await post()).status).toBe(403)
  expect(mocks.credentials).not.toHaveBeenCalled()
})
it('withholds a candidate if policy changes during preparation and keeps errors private', async () => {
  mocks.authorize.mockResolvedValueOnce({ revision: deviceId }).mockResolvedValueOnce({ revision: ownerId })
  expect((await post()).status).toBe(409)
  mocks.plan.mockRejectedValueOnce(new Error('PRIVATE_TOKEN_VALUE'))
  const response = await post()
  expect(response.status).toBe(409); expect(await response.text()).not.toContain('PRIVATE_TOKEN')
})
it('rechecks activation authority without reading a repository and rejects caller identity fields', async () => {
  expect((await post({ ...body, operation: 'authorize' })).status).toBe(200)
  expect(mocks.credentials).not.toHaveBeenCalled()
  expect((await post({ ...body, ownerId } as typeof body)).status).toBe(409)
  expect(mocks.authenticate).toHaveBeenCalledTimes(1)
})
