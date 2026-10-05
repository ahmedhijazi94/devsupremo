import { afterEach, describe, expect, it, vi } from 'vitest'
import { authOptionsSchema, authRequestSchema } from './options'
import { runAuthAdmin } from './service'
import { supabaseAuthAdminProvider } from './provider'
import { authMutationCapability, authMutationEffects } from './evidence'
import { policyInputSchema } from '../backend-operations/contract'
import { operationApproval } from '../backend-operations/approvals'

const userId = '11111111-1111-4111-8111-111111111111'
const options = { operation: 'auth-invite', environment: 'development', email: 'Person+invite@example.test' } as const
const user: { id: string; email: string; invited_at: string } = { id: userId, email: options.email, invited_at: '2026-10-05T12:00:00.000Z' }
const provider = () => ({ management: vi.fn(), user: vi.fn(async () => user), invite: vi.fn(async () => user) })
afterEach(() => vi.unstubAllGlobals())

describe('Auth invitations', () => {
  it('preserves the complete 332-character invitation resource through policy and approval views', () => {
    const email = `${'a'.repeat(64)}@${['b'.repeat(63), 'c'.repeat(63), 'd'.repeat(63), 'e'.repeat(59), 'com'].join('.')}`
    expect(email).toHaveLength(320)
    const options = authOptionsSchema.parse({ operation: 'auth-invite', environment: 'development', email })
    const resource = authMutationEffects(options).resource
    expect(resource).toHaveLength(332)
    const policy = policyInputSchema.parse({ projectId: userId, environment: 'development', expectedRevision: null,
      enabled: true, capabilities: ['auth.invite'], maxRows: 1, maxOperationsPerHour: 1, resources: [resource], deviceIds: [] })
    expect(policy.resources).toEqual([resource])
    expect(operationApproval({ id: userId, operation_id: userId, user_id: userId, project_id: userId, policy_id: userId, policy_revision: userId,
      environment: 'development', device_id: userId, owner_session: false, project_ref: 'owned-ref', account_id: null,
      input_digest: 'a'.repeat(64), capability: 'auth.invite', resource, affected_rows: 1, review: [], status: 'pending', expires_at: '2026-10-05T12:00:00Z', created_at: '2026-10-05T11:00:00Z' }).resource).toBe(resource)
    expect(authOptionsSchema.safeParse({ operation: 'auth-invite', environment: 'development', email: `a${email}` }).success).toBe(false)
  })

  it('keeps invite authority separate and binds exactly one recipient', () => {
    expect(authMutationCapability(options)).toBe('auth.invite')
    expect(authMutationEffects(options)).toEqual({ rows: 1, resource: 'auth.invite:person+invite@example.test' })
    expect(authOptionsSchema.parse({ ...options, environment: 'production' })).toMatchObject({ operation: 'auth-invite' })
    const request = { ...options, deviceSecret: 'fixture-device-value', projectId: userId, expectedRef: 'owned-ref' }
    expect(authRequestSchema.safeParse(request).success).toBe(false)
    expect(authRequestSchema.safeParse({ ...request, operationId: userId }).success).toBe(true)
  })
  it.each([
    { environment: 'unknown' }, { email: 'invalid' }, { password: 'private-value' }, { token: 'private-value' },
    { redirectTo: 'https://user:private-value@app.test/callback' }, { redirectTo: 'http://external.test' },
    { redirectTo: 'https://app.test/callback?token=value' }, { redirectTo: 'https://app.test/callback#token' },
  ])('rejects unsafe or credential-bearing invitation input %o', extra => {
    expect(authOptionsSchema.safeParse({ ...options, ...extra }).success).toBe(false)
  })
  it('proves accepted invitation and readback while stripping tokens, links and metadata', async () => {
    const p = provider()
    p.invite.mockResolvedValue({ ...user, invitation_token: 'private-token', action_link: 'private-link' } as typeof user)
    p.user.mockResolvedValue({ ...user, app_metadata: { private: 'private-metadata' }, confirmation_token: 'private-token' } as typeof user)
    expect(await runAuthAdmin(p, options)).toEqual({ user, invitationAccepted: true, userObserved: true, deliveryVerified: false, verified: true })
    expect(p.invite).toHaveBeenCalledExactlyOnceWith(options.email, undefined)
    expect(p.user).toHaveBeenCalledExactlyOnceWith('GET', userId)
    expect(p.management).not.toHaveBeenCalled()
  })
  it.each(['https://app.test', 'https://app.test/callback', 'http://localhost:3000/callback'])('accepts only the exact configured redirect %s', async redirectTo => {
    const p = provider()
    p.management.mockResolvedValue({ mailer_autoconfirm: false, disable_signup: false, site_url: 'https://app.test', uri_allow_list: 'https://app.test/callback, http://localhost:3000/callback' })
    await expect(runAuthAdmin(p, { ...options, redirectTo })).resolves.toMatchObject({ invitationAccepted: true })
    expect(p.management).toHaveBeenCalledExactlyOnceWith('config/auth', 'GET')
    expect(p.invite).toHaveBeenCalledExactlyOnceWith(options.email, redirectTo)
  })
  it('rejects an unlisted or wildcard-only redirect before sending an invitation', async () => {
    const p = provider()
    p.management.mockResolvedValue({ mailer_autoconfirm: false, disable_signup: false, site_url: 'https://app.test', uri_allow_list: 'https://*.example.test/**' })
    await expect(runAuthAdmin(p, { ...options, redirectTo: 'https://other.example.test/callback' })).rejects.toThrow('URL exata')
    expect(p.invite).not.toHaveBeenCalled()
  })
  it.each([
    { id: '22222222-2222-4222-8222-222222222222' }, { email: 'other@example.test' },
    { invited_at: null }, { invited_at: 'not-a-date' }, { invited_at: '2026-10-05T13:00:00.000Z' },
  ])('does not claim a verified invitation when readback differs: %o', extra => {
    const p = provider()
    p.user.mockResolvedValue({ ...user, ...extra } as typeof user)
    return expect(runAuthAdmin(p, options)).rejects.toThrow()
  })
  it('does not query an unrelated user returned by the invitation endpoint', async () => {
    const p = provider()
    p.invite.mockResolvedValue({ ...user, email: 'other@example.test' })
    await expect(runAuthAdmin(p, options)).rejects.toThrow('outro destinatário')
    expect(p.user).not.toHaveBeenCalled()
    await expect(runAuthAdmin({ management: vi.fn(), user: vi.fn() }, options)).rejects.toThrow('indisponível')
  })
  it('sends only email to the fixed GoTrue invite endpoint after fresh key lookup', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json([{ name: 'service_role', api_key: 'server-only-fixture' }]))
      .mockResolvedValueOnce(Response.json(user))
    vi.stubGlobal('fetch', fetcher)
    const resolve = vi.fn(async () => ({ projectRef: 'owned-ref', token: 'management-fixture' }))
    const p = supabaseAuthAdminProvider(resolve, [])
    await p.invite!(options.email, 'https://app.test/callback')
    expect(fetcher).toHaveBeenLastCalledWith('https://owned-ref.supabase.co/auth/v1/invite?redirect_to=https%3A%2F%2Fapp.test%2Fcallback', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ email: options.email }), redirect: 'error',
      headers: expect.objectContaining({ Authorization: 'Bearer server-only-fixture', apikey: 'server-only-fixture' }),
    }))
    expect(resolve).toHaveBeenCalledTimes(3)
  })
  it('does not send invitation after its authority is revoked during private key lookup', async () => {
    const resolve = vi.fn(async () => ({ projectRef: 'owned-ref', token: 'management-fixture' }))
    const fetcher = vi.fn(async () => {
      resolve.mockRejectedValue(new Error('authorization revoked'))
      return Response.json([{ name: 'service_role', api_key: 'server-only-fixture' }])
    })
    vi.stubGlobal('fetch', fetcher)
    await expect(supabaseAuthAdminProvider(resolve, []).invite!(options.email)).rejects.toThrow('revoked')
    expect(fetcher).toHaveBeenCalledOnce()
  })
})
