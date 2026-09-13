import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { POST } from './route'
import { authenticateDeviceSecret } from '@/lib/checkpoint/devices'
import { getProject, getSupabaseCredentials } from '@/lib/projects/repository'
import { readEnvironment } from '@/lib/database-environment/store'
vi.mock('@/lib/supabase/admin', () => ({ createServiceClient: () => ({}) }))
vi.mock('@/lib/checkpoint/store', () => ({ supabaseCheckpointDeviceStore: () => ({}) }))
vi.mock('@/lib/checkpoint/devices', () => ({ authenticateDeviceSecret: vi.fn() }))
vi.mock('@/lib/projects/repository', () => ({ getProject: vi.fn(), getSupabaseCredentials: vi.fn() }))
vi.mock('@/lib/database-environment/store', () => ({ readEnvironment: vi.fn(), registerDevelopment: vi.fn() }))
const body = { deviceSecret: 'sup_dev_ckpt_fixture', projectId: '00000000-0000-4000-8000-000000000001', operation: 'status' }
function request(extra: Record<string, unknown> = {}) { return new NextRequest('https://supremo.test/api/database', { method: 'POST', body: JSON.stringify({ ...body, ...extra }) }) }
beforeEach(() => {
  vi.mocked(authenticateDeviceSecret).mockResolvedValue({ ok: true, device: { id: 'device', ownerUserId: 'owner', revokedAt: null, label: null } })
  vi.mocked(getProject).mockResolvedValue({ id: body.projectId, user_id: 'owner', supabase_project_ref: 'dev-ref' } as Awaited<ReturnType<typeof getProject>>)
  vi.mocked(readEnvironment).mockResolvedValue({ project_ref: 'dev-ref', environment: 'development', source: 'supremo_provisioned' })
  vi.mocked(getSupabaseCredentials).mockResolvedValue({ projectRef: 'dev-ref', token: 'fixture' } as Awaited<ReturnType<typeof getSupabaseCredentials>>)
  vi.stubGlobal('fetch', vi.fn(async () => Response.json([])))
})
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals() })
describe('API do banco: dispositivo, dono e ambiente', () => {
  it('counts auth users through the fixed server query, without granting general auth SQL', async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json([{ count: 7 }]))
    const response = await POST(request({ operation: 'auth-count', expectedRef: 'dev-ref', environment: 'development' }))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ readOnly: true, data: { users: 7 }, environment: 'development' })
    expect(fetch).toHaveBeenCalledWith('https://api.supabase.com/v1/projects/dev-ref/database/query/read-only', expect.objectContaining({ method: 'POST',
      body: expect.stringContaining('SELECT count(*) AS count FROM auth.users'), redirect: 'error' }))
    expect((await POST(request({ operation: 'auth-count', expectedRef: 'dev-ref', environment: 'development', sql: 'SELECT * FROM auth.users' }))).status).toBe(400)
  })
  it('changes email confirmation with a minimal patch and verifies it without disclosing SMTP credentials', async () => {
    const config = { mailer_autoconfirm: false, disable_signup: false, smtp_pass: 'server-only-password' }
    vi.mocked(fetch).mockResolvedValueOnce(Response.json(config)).mockResolvedValueOnce(Response.json({}))
      .mockResolvedValueOnce(Response.json({ ...config, mailer_autoconfirm: true }))
    const response = await POST(request({ operation: 'auth-configure', expectedRef: 'dev-ref', environment: 'development', config: { emailConfirmation: false } }))
    expect(response.status).toBe(200)
    const data: unknown = await response.json()
    expect(data).toMatchObject({ readOnly: false, data: { before: { emailConfirmation: true }, after: { emailConfirmation: false }, verified: true } })
    expect(JSON.stringify(data)).not.toContain('server-only-password')
    expect(vi.mocked(fetch).mock.calls[1]?.[1]?.body).toBe('{"mailer_autoconfirm":true}')
  })
  it('revocation between configuration read and write prevents the write', async () => {
    let authorized = true
    vi.mocked(authenticateDeviceSecret).mockImplementation(async () => authorized ? { ok: true, device: { id: 'device', ownerUserId: 'owner', revokedAt: null, label: null } } : { ok: false, reason: 'revoked' })
    vi.mocked(fetch).mockImplementation(async () => { authorized = false; return Response.json({ mailer_autoconfirm: false, disable_signup: false }) })
    const response = await POST(request({ operation: 'auth-configure', expectedRef: 'dev-ref', environment: 'development', config: { emailConfirmation: false } }))
    expect(response.status).toBe(401)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(vi.mocked(fetch).mock.calls[0]?.[1]?.method).toBe('GET')
  })
  it('never uses user administration credentials from a changed account', async () => {
    vi.mocked(fetch).mockImplementation(async () => {
      vi.mocked(getProject).mockResolvedValue({ id: body.projectId, user_id: 'owner', supabase_project_ref: 'dev-ref', supabase_account_id: 'other-account' } as Awaited<ReturnType<typeof getProject>>)
      return Response.json([{ name: 'service_role', api_key: 'server-admin-fixture' }])
    })
    expect((await POST(request({ operation: 'auth-delete', expectedRef: 'dev-ref', environment: 'development', userId: body.projectId }))).status).toBe(409)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('keeps admin keys on the server and passes only the selected user update', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json([{ name: 'service_role', api_key: 'server-admin-fixture' }]))
      .mockResolvedValueOnce(Response.json({ id: body.projectId, email: 'a@example.test', app_metadata: { key: 'server-admin-fixture' }, recovery_token: 'hidden' }))
    const response = await POST(request({ operation: 'auth-update', expectedRef: 'dev-ref', environment: 'development', userId: body.projectId, user: { banHours: 24 } }))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ data: { user: { id: body.projectId, email: 'a@example.test' } } })
    expect(fetch).toHaveBeenLastCalledWith(`https://dev-ref.supabase.co/auth/v1/admin/users/${body.projectId}`, expect.objectContaining({ method: 'PUT', body: '{"ban_duration":"24h"}' }))
  })
  it.each(['foreign-ref', null])('refuses auth operations for target %s', async ref => {
    if (ref === null) vi.mocked(readEnvironment).mockResolvedValue(null)
    expect((await POST(request({ operation: 'auth-configure', expectedRef: ref ?? 'dev-ref', environment: 'development', config: { emailConfirmation: false } }))).status).toBe(409)
    expect(fetch).not.toHaveBeenCalled()
  })
  it('status machine-readable consulta o projeto pelo dono autenticado', async () => {
    const response = await POST(request())
    expect(await response.json()).toMatchObject({ environment: 'development', automaticMigrations: true })
    expect(getProject).toHaveBeenCalledWith('owner', body.projectId)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(fetch).not.toHaveBeenCalled()
  })
  it('refuta dispositivo revogado e projeto de outro dono sem acessar o provedor', async () => {
    vi.mocked(authenticateDeviceSecret).mockResolvedValueOnce({ ok: false, reason: 'revoked' })
    expect((await POST(request())).status).toBe(401)
    expect(getProject).not.toHaveBeenCalled()
    vi.mocked(getProject).mockRejectedValueOnce(new Error('Projeto não encontrado.'))
    expect((await POST(request({ operation: 'anonymous-auth', expectedRef: 'dev-ref' }))).status).toBe(409)
    expect(fetch).not.toHaveBeenCalled()
  })
  it.each(['production', null] as const)('recusa configuração e SQL em %s', async (environment) => {
    vi.mocked(readEnvironment).mockResolvedValue(environment ? { environment, source: 'supremo_provisioned', project_ref: 'dev-ref' } : null)
    for (const operation of ['migrate', 'anonymous-auth']) {
      expect((await POST(request({ operation, expectedRef: 'dev-ref' }))).status).toBe(409)
    }
    expect(fetch).not.toHaveBeenCalled()
  })
  it('configura apenas Anonymous Auth e confirma o resultado', async () => {
    vi.mocked(fetch).mockImplementation(async (url) => {
      if (String(url).endsWith('/api-keys')) return Response.json([{ name: 'anon', api_key: 'public-fixture' }])
      if (String(url).endsWith('/settings')) return Response.json({ external: { anonymous_users: true }, disable_signup: false })
      return Response.json({ external_anonymous_users_enabled: true })
    })
    expect((await POST(request({ operation: 'anonymous-auth', expectedRef: 'dev-ref' }))).status).toBe(200)
    expect(fetch).toHaveBeenCalledWith('https://api.supabase.com/v1/projects/dev-ref/config/auth', expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ external_anonymous_users_enabled: true }) }))
  })
  it('falha explícita se configuração não foi confirmada ou provedor recusou', async () => {
    expect((await POST(request({ operation: 'anonymous-auth', expectedRef: 'dev-ref' }))).status).toBe(409)
    vi.mocked(fetch).mockResolvedValue(new Response('unavailable', { status: 503 }))
    const response = await POST(request({ operation: 'migrate', expectedRef: 'dev-ref' }))
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('Nenhum fallback') })
  })
  it('recusa vínculo que mudou antes de usar credenciais', async () => {
    vi.mocked(getSupabaseCredentials).mockResolvedValue({ projectRef: 'production-ref', token: 'fixture' } as Awaited<ReturnType<typeof getSupabaseCredentials>>)
    expect((await POST(request({ operation: 'migrate', expectedRef: 'dev-ref' }))).status).toBe(409)
    expect(fetch).not.toHaveBeenCalled()
  })
  it('rejeita payload inválido, autoridade forjada, ref ausente e corpo excessivo', async () => {
    expect((await POST(request({ environment: 'development' }))).status).toBe(400)
    expect((await POST(request({ operation: 'migrate' }))).status).toBe(400)
    expect((await POST(new NextRequest('https://supremo.test/api/database', { method: 'POST', body: '{bad' }))).status).toBe(400)
    expect((await POST(new NextRequest('https://supremo.test/api/database', { method: 'POST', body: 'x'.repeat(1_000_001) }))).status).toBe(413)
  })
})
