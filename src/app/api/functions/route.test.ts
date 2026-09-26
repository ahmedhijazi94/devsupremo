import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
const mocks = vi.hoisted(() => ({ auth: vi.fn(), project: vi.fn(), environment: vi.fn(), credentials: vi.fn(), insert: vi.fn(), claim: vi.fn(), assert: vi.fn(), release: vi.fn() }))
vi.mock('@/lib/supabase/admin', () => ({ createServiceClient: () => ({ from: () => ({ insert: mocks.insert }) }) }))
vi.mock('@/lib/checkpoint/devices', () => ({ authenticateDeviceSecret: mocks.auth }))
vi.mock('@/lib/checkpoint/store', () => ({ supabaseCheckpointDeviceStore: () => ({}) }))
vi.mock('@/lib/projects/repository', () => ({ getProject: mocks.project, getSupabaseCredentials: mocks.credentials }))
vi.mock('@/lib/database-environment/store', () => ({ readEnvironment: mocks.environment }))
vi.mock('@/lib/edge-functions/store', () => ({ claimFunctionLease: mocks.claim }))
import { POST } from './route'
import { runAuthorizedFunctions } from '@/lib/edge-functions/server'
import { FunctionError } from '@/lib/edge-functions/policy'
const projectId = '00000000-0000-4000-8000-000000000001'
const ownerId = '00000000-0000-4000-8000-000000000002'
const foreignOwner = '00000000-0000-4000-8000-000000000003'
const project = { id: projectId, user_id: ownerId, supabase_project_ref: 'own-ref', supabase_account_id: 'own-account' }
const body = { projectId, deviceSecret: 'sup_dev_ckpt_fixture', expectedRef: 'own-ref', environment: 'development', operation: 'functions-list' }
const functionRecord = { id: 'private-id', slug: 'send-email', status: 'ACTIVE', version: 1, verify_jwt: true, private_token: 'private-provider-value' }
const deploy = { ...body, operation: 'functions-deploy', slug: 'send-email', entrypoint: 'supabase/functions/send-email/index.ts',
  files: [{ path: 'supabase/functions/send-email/index.ts', content: 'Deno.serve(() => new Response("private-source"))' }], verifyJwt: true }
const request = (payload: unknown = body) => new NextRequest('https://supremo.example/api/functions', { method: 'POST', body: JSON.stringify(payload) })
const fetchMock = vi.fn<typeof fetch>()
beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('fetch', fetchMock)
  mocks.auth.mockResolvedValue({ ok: true, device: { ownerUserId: ownerId } })
  mocks.project.mockResolvedValue({ ...project })
  mocks.environment.mockResolvedValue({ project_ref: 'own-ref', environment: 'development', source: 'supremo_provisioned' })
  mocks.credentials.mockResolvedValue({ projectRef: 'own-ref', token: 'private-provider-token' })
  mocks.insert.mockResolvedValue({ error: null })
  mocks.claim.mockResolvedValue({ assertCurrent: mocks.assert, release: mocks.release })
  fetchMock.mockImplementation(async () => Response.json([functionRecord]))
})
afterEach(() => vi.unstubAllGlobals())
describe('functions device API and shared authorization', () => {
  it('validates payload, explicit environment and bounded body before device access', async () => {
    for (const payload of [{ ...body, rawToken: 'secret' }, { ...body, targetUrl: 'https://foreign.test' }, { ...body, expectedRef: 'own-ref\n' },
      { ...body, ownerId: foreignOwner }, { ...body, environment: undefined }, { ...deploy, files: [{ path: '.env', content: 'secret' }] }])
      expect((await POST(request(payload))).status).toBe(400)
    expect((await POST(request({ ...body, huge: 'x'.repeat(3_300_001) }))).status).toBe(413)
    expect((await POST(new NextRequest('https://supremo.example/api/functions', { method: 'POST', body: '{' }))).status).toBe(400)
    expect(mocks.auth).not.toHaveBeenCalled()
  })
  it('rejects revoked devices before private project reads', async () => {
    mocks.auth.mockResolvedValue({ ok: false })
    expect((await POST(request())).status).toBe(401)
    expect(mocks.project).not.toHaveBeenCalled(); expect(fetchMock).not.toHaveBeenCalled()
  })
  it('passes only authenticated owner into the repository, refuses foreign projects without reflected details', async () => {
    mocks.project.mockRejectedValue(new Error('private foreign project data'))
    const response = await POST(request())
    expect(response.status).toBe(409)
    expect(mocks.project).toHaveBeenCalledExactlyOnceWith(ownerId, projectId)
    expect(await response.text()).not.toContain('private foreign')
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('returns only whitelisted metadata, with no token, source, function id or arbitrary private fields', async () => {
    const response = await POST(request())
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store')
    const result = await response.json()
    expect(result).toMatchObject({ projectId, projectRef: 'own-ref', operation: 'functions-list', environment: 'development', readOnly: true,
      execution: 'server_api', providerDashboardRequired: false, valuesReceived: false,
      data: { functions: [{ slug: 'send-email', status: 'ACTIVE', version: 1, verifyJwt: true }] } })
    expect(JSON.stringify(result)).not.toMatch(/private-|sup_dev_ckpt|deviceSecret/)
    expect(mocks.auth).toHaveBeenCalledTimes(5)
    expect(mocks.insert).not.toHaveBeenCalled(); expect(mocks.claim).not.toHaveBeenCalled()
  })
  it('allows production only when explicitly selected and registered on the exact ref', async () => {
    mocks.environment.mockResolvedValue({ project_ref: 'own-ref', environment: 'production', source: 'supremo_provisioned' })
    expect((await POST(request())).status).toBe(409)
    expect(fetchMock).not.toHaveBeenCalled()
    const response = await POST(request({ ...body, environment: 'production' }))
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ environment: 'production' })
    mocks.environment.mockResolvedValue(null)
    expect((await POST(request({ ...body, environment: 'production' }))).status).toBe(409)
  })
  it.each(['before-fetch', 'after-token', 'after-read'])('rejects device revocation %s', async stage => {
    if (stage === 'before-fetch') mocks.auth.mockResolvedValueOnce({ ok: true, device: { ownerUserId: ownerId } }).mockResolvedValue({ ok: false })
    if (stage === 'after-token') mocks.credentials.mockImplementation(async () => { mocks.auth.mockResolvedValue({ ok: false }); return { projectRef: 'own-ref', token: 'private-provider-token' } })
    if (stage === 'after-read') fetchMock.mockImplementation(async () => { mocks.auth.mockResolvedValue({ ok: false }); return Response.json([functionRecord]) })
    const response = await POST(request()); expect(response.status).toBe(401)
    expect(await response.text()).not.toContain('private-')
    expect(fetchMock).toHaveBeenCalledTimes(stage === 'after-read' ? 1 : 0)
  })
  it('rejects a device whose owner changes and the shared panel identity mismatch', async () => {
    mocks.auth.mockResolvedValueOnce({ ok: true, device: { ownerUserId: ownerId } }).mockResolvedValue({ ok: true, device: { ownerUserId: foreignOwner } })
    expect((await POST(request())).status).toBe(401)
    await expect(runAuthorizedFunctions({ client: {} as SupabaseClient, ownerId, projectId, expectedRef: 'own-ref', verifyIdentity: async () => foreignOwner },
      { operation: 'functions-list', environment: 'development' })).rejects.toThrow('Identidade')
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it.each(['ref', 'account', 'credential-ref'])('refuses a %s change during credential resolution', async field => {
    mocks.credentials.mockImplementation(async () => {
      if (field === 'ref') mocks.project.mockResolvedValue({ ...project, supabase_project_ref: 'foreign-ref' })
      if (field === 'account') mocks.project.mockResolvedValue({ ...project, supabase_account_id: 'foreign-account' })
      return { projectRef: field === 'credential-ref' ? 'foreign-ref' : 'own-ref', token: 'private-token' }
    })
    expect((await POST(request())).status).toBe(409)
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('rejects account relink before credential resolution', async () => {
    mocks.project.mockResolvedValueOnce(project).mockResolvedValue({ ...project, supabase_account_id: 'foreign-account' })
    expect((await POST(request())).status).toBe(409)
    expect(mocks.credentials).not.toHaveBeenCalled(); expect(fetchMock).not.toHaveBeenCalled()
  })
  it.each(['read', 'deploy'])('rejects an account relink after the final %s provider call without returning metadata or releasing the lease', async operation => {
    if (operation === 'deploy') fetchMock.mockResolvedValueOnce(Response.json(functionRecord))
    fetchMock.mockImplementation(async () => {
      mocks.project.mockResolvedValue({ ...project, supabase_account_id: 'replacement-account' })
      return Response.json(operation === 'read' ? [functionRecord] : functionRecord)
    })
    const response = await POST(request(operation === 'read' ? body : deploy))
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'Conta do Supabase mudou durante a operação.' })
    expect(fetchMock).toHaveBeenCalledTimes(operation === 'read' ? 1 : 2)
    expect(mocks.release).not.toHaveBeenCalled()
  })
  it('audits metadata before writes, leases all mutations and releases only confirmed success', async () => {
    fetchMock.mockImplementation(async () => Response.json(functionRecord))
    expect((await POST(request(deploy))).status).toBe(200)
    expect(mocks.insert).toHaveBeenCalledWith({ user_id: ownerId, action: 'functions-deploy.requested', resource_type: 'project', resource_id: projectId,
      metadata: { slug: 'send-email', environment: 'development', targetRef: 'own-ref' }, ip_address: null })
    expect(JSON.stringify(mocks.insert.mock.calls)).not.toMatch(/private-source|Deno|private-token/)
    expect(mocks.claim).toHaveBeenCalledOnce(); expect(mocks.assert).toHaveBeenCalledTimes(4); expect(mocks.release).toHaveBeenCalledOnce()
    expect(mocks.insert.mock.invocationCallOrder[0]).toBeLessThan(fetchMock.mock.invocationCallOrder[0]!)
  })
  it('fails closed on audit error before claiming or publishing', async () => {
    mocks.insert.mockResolvedValue({ error: { message: 'private database details' } })
    const response = await POST(request(deploy)); expect(response.status).toBe(503)
    expect(await response.text()).not.toContain('private database')
    expect(mocks.claim).not.toHaveBeenCalled(); expect(fetchMock).not.toHaveBeenCalled()
  })
  it('stops a conflicting/expired lease before writes and retains uncertain operation lease', async () => {
    mocks.claim.mockRejectedValueOnce(new FunctionError('Conflito de reserva.'))
    expect((await POST(request(deploy))).status).toBe(409)
    mocks.assert.mockRejectedValueOnce(new FunctionError('Reserva expirada.'))
    expect((await POST(request(deploy))).status).toBe(409)
    expect(fetchMock).not.toHaveBeenCalled()
    fetchMock.mockRejectedValueOnce(new Error('private network token'))
    expect((await POST(request(deploy))).status).toBe(502)
    expect(mocks.release).not.toHaveBeenCalled()
  })
  it('does not perform deployment readback after revoked identity', async () => {
    fetchMock.mockImplementation(async () => { mocks.auth.mockResolvedValue({ ok: false }); return Response.json(functionRecord) })
    expect((await POST(request(deploy))).status).toBe(401)
    expect(fetchMock).toHaveBeenCalledOnce(); expect(mocks.release).not.toHaveBeenCalled()
  })
  it('rejects unexpected provider data without reflecting it', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ error: 'private-provider-value' }))
    const response = await POST(request()); expect(response.status).toBe(502)
    expect(await response.text()).not.toContain('private-provider-value')
  })
})
