import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { POST } from './route'
import { authenticateDeviceSecret } from '@/lib/checkpoint/devices'
import { getProject, getSupabaseCredentials } from '@/lib/projects/repository'
import { readEnvironment } from '@/lib/database-environment/store'
vi.mock('@/lib/supabase/admin', () => ({ createServiceClient: () => ({}) }))
vi.mock('@/lib/checkpoint/store', () => ({
  supabaseCheckpointDeviceStore: () => ({}),
}))
vi.mock('@/lib/checkpoint/devices', () => ({
  authenticateDeviceSecret: vi.fn(),
}))
vi.mock('@/lib/projects/repository', () => ({
  getProject: vi.fn(),
  getSupabaseCredentials: vi.fn(),
}))
vi.mock('@/lib/database-environment/store', () => ({
  readEnvironment: vi.fn(),
}))
const identity = {
  deviceSecret: 'device-secret-fixture',
  projectId: '00000000-0000-4000-8000-000000000001',
}
const body = {
  ...identity,
  operation: 'query',
  environment: 'development',
  expectedRef: 'project-ref',
  sql: 'SELECT id,title FROM public.tickets',
}
const request = (extra: Record<string, unknown> = {}) =>
  new NextRequest('https://supremo.test/api/database', {
    method: 'POST',
    body: JSON.stringify({ ...body, ...extra }),
  })
beforeEach(() => {
  vi.mocked(authenticateDeviceSecret).mockResolvedValue({
    ok: true,
    device: {
      id: 'device',
      ownerUserId: 'owner',
      revokedAt: null,
      label: null,
    },
  })
  vi.mocked(getProject).mockResolvedValue({
    id: identity.projectId,
    user_id: 'owner',
    supabase_project_ref: 'project-ref',
  } as Awaited<ReturnType<typeof getProject>>)
  vi.mocked(readEnvironment).mockResolvedValue({
    project_ref: 'project-ref',
    environment: 'development',
    source: 'supremo_provisioned',
  })
  vi.mocked(getSupabaseCredentials).mockResolvedValue({
    projectRef: 'project-ref',
    token: 'provider-secret-fixture',
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json([
        {
          id: 1,
          title: 'real row',
          credential: 'hidden',
          message: identity.deviceSecret,
        },
      ]),
    ),
  )
})
afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('device-authenticated real project inspection route', () => {
  it('responds with authoritative project/environment, untrusted evidence and no credential disclosure', async () => {
    const response = await POST(request())
    expect(response.status).toBe(200)
    const result = await response.json()
    expect(result).toMatchObject({
      projectId: identity.projectId,
      projectRef: 'project-ref',
      environment: 'development',
      readOnly: true,
      untrustedData: true,
      data: {
        rows: [
          {
            id: 1,
            title: 'real row',
            credential: '[REDACTED]',
            message: '[REDACTED]',
          },
        ],
        rowCount: 1,
        redacted: true,
      },
      limits: { rows: 50, statementTimeoutMs: 8000 },
    })
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(getProject).toHaveBeenCalledTimes(2)
    expect(getProject).toHaveBeenCalledWith('owner', identity.projectId)
    expect(getSupabaseCredentials).toHaveBeenCalledWith(
      'owner',
      expect.objectContaining({ id: identity.projectId }),
    )
    expect(JSON.stringify(result)).not.toContain('provider-secret-fixture')
  })
  it.each(['production', 'unknown'] as const)(
    'permits %s read without allowing mutations',
    async (environment) => {
      vi.mocked(readEnvironment).mockResolvedValue(
        environment === 'unknown'
          ? null
          : {
              project_ref: 'project-ref',
              environment,
              source: 'supremo_provisioned',
            },
      )
      expect((await POST(request({ environment }))).status).toBe(200)
      vi.mocked(fetch).mockClear()
      expect(
        (
          await POST(
            request({
              operation: 'migrate',
              environment: undefined,
              sql: undefined,
            }),
          )
        ).status,
      ).toBe(409)
      expect(fetch).not.toHaveBeenCalled()
    },
  )
  it('rejects revoked device and other owner before accessing provider', async () => {
    vi.mocked(authenticateDeviceSecret).mockResolvedValueOnce({
      ok: false,
      reason: 'revoked',
    })
    expect((await POST(request())).status).toBe(401)
    vi.mocked(getProject).mockRejectedValueOnce(
      new Error('owner-secret-database-detail'),
    )
    const response = await POST(request())
    expect(response.status).toBe(409)
    expect(JSON.stringify(await response.json())).not.toContain('owner-secret')
    expect(fetch).not.toHaveBeenCalled()
  })
  it('rechecks owner/device/ref and environment immediately before each provider request', async () => {
    vi.mocked(authenticateDeviceSecret)
      .mockResolvedValueOnce({
        ok: true,
        device: {
          id: 'device',
          ownerUserId: 'owner',
          revokedAt: null,
          label: null,
        },
      })
      .mockResolvedValueOnce({ ok: false, reason: 'revoked' })
    expect((await POST(request())).status).toBe(401)
    expect(fetch).not.toHaveBeenCalled()
    vi.mocked(readEnvironment)
      .mockResolvedValueOnce({
        project_ref: 'project-ref',
        environment: 'development',
        source: 'supremo_provisioned',
      })
      .mockResolvedValueOnce({
        project_ref: 'project-ref',
        environment: 'production',
        source: 'supremo_provisioned',
      })
    expect((await POST(request())).status).toBe(409)
    expect(fetch).not.toHaveBeenCalled()
    vi.mocked(getSupabaseCredentials).mockResolvedValueOnce({
      projectRef: 'another-project',
      token: 'secret',
    })
    expect((await POST(request())).status).toBe(409)
    expect(fetch).not.toHaveBeenCalled()
  })
  it('rejects asserted environment/ref, query writes and unknown authority fields', async () => {
    expect((await POST(request({ environment: 'production' }))).status).toBe(
      409,
    )
    expect((await POST(request({ expectedRef: 'other-project' }))).status).toBe(
      409,
    )
    expect((await POST(request({ environment: undefined }))).status).toBe(400)
    expect(
      (await POST(request({ sql: 'DELETE FROM public.tickets' }))).status,
    ).toBe(409)
    expect((await POST(request({ serviceRoleKey: 'arbitrary' }))).status).toBe(
      400,
    )
    expect(fetch).not.toHaveBeenCalled()
  })
  it('logs permission failure stays explicit; report preserves partial availability', async () => {
    vi.mocked(fetch).mockImplementation(async (url) =>
      String(url).includes('/analytics/')
        ? new Response('api_key=private', { status: 403 })
        : Response.json([{ count: 1 }]),
    )
    const response = await POST(request({ operation: 'logs', sql: undefined }))
    expect(response.status).toBe(502)
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining('HTTP 403'),
    })
    const report = await POST(request({ operation: 'report', sql: undefined }))
    expect(report.status).toBe(200)
    expect(await report.json()).toMatchObject({
      data: {
        complete: false,
        sections: {
          logs: { status: 'unavailable' },
          structure: { status: 'ok' },
          diagnostics: { status: 'ok' },
        },
      },
    })
  })
})
