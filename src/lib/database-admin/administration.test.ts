import { describe, it, expect, vi } from 'vitest'
import { authOptionsSchema } from './options'
import { runAuthAdmin, type AuthAdminProvider } from './service'
import { authAdministrationSql } from './administration-sql'
import { currentApplicationRole, applicationRoleManifestSchema } from './claims'

const id = '11111111-1111-4111-8111-111111111111',
  session = '22222222-2222-4222-8222-222222222222'
const provider = (): AuthAdminProvider => ({
  management: vi.fn(),
  user: vi.fn(),
  roles: vi.fn(async () => ({
    userId: id,
    roles: ['editor'],
    revision: id,
    revokedSessions: 2,
    remainingSessions: 0,
  })),
  revokeSessions: vi.fn(async () => ({
    userId: id,
    revokedSessions: 1,
    remainingSessions: 0,
  })),
})
const roles = {
  operation: 'auth-role-set' as const,
  environment: 'development' as const,
  userId: id,
  roles: ['editor'],
  manifestVersion: 1 as const,
}
describe('application roles and session control', () => {
  it('requires owner policy and both role/session capabilities; text is not authorization', async () => {
    const port = provider()
    await expect(runAuthAdmin(port, roles)).rejects.toThrow(/política/)
    const authorize = vi.fn(async () => ({ policyId: id, revision: id }))
    await expect(
      runAuthAdmin(port, roles, { authorize }),
    ).resolves.toMatchObject({
      claimsSaved: true,
      refreshSessionsRevoked: true,
      accessTokensMayRemainValid: true,
    })
    expect(authorize).toHaveBeenCalledWith('auth.roles', {
      rows: 1,
      resource: 'role:editor',
    })
    expect(authorize).toHaveBeenCalledWith('auth.sessions', {
      rows: 1,
      resource: `auth.users:${id}`,
    })
    await expect(
      runAuthAdmin(port, roles, {
        authorize: async () => {
          throw new Error('revoked')
        },
      }),
    ).rejects.toThrow(/revoked/)
    expect(port.roles).toHaveBeenCalledTimes(1)
  })
  it('rejects database roles, user metadata, production role writes and malformed manifests', () => {
    for (const role of [
      'postgres',
      'service_role',
      'anon',
      'authenticated',
      'superuser',
      'bypassrls',
    ])
      expect(
        authOptionsSchema.safeParse({ ...roles, roles: [role] }).success,
      ).toBe(false)
    expect(
      authOptionsSchema.safeParse({ ...roles, environment: 'production' })
        .success,
    ).toBe(false)
    expect(
      authOptionsSchema.safeParse({
        ...roles,
        user_metadata: { role: 'editor' },
      }).success,
    ).toBe(false)
    expect(
      applicationRoleManifestSchema.safeParse({ version: 2, roles: ['editor'] })
        .success,
    ).toBe(false)
  })
  it('does not confirm mismatched provider roles or claim full JWT invalidation', async () => {
    const port = provider(),
      authority = { authorize: vi.fn(async () => undefined) }
    port.roles = vi.fn(async () => ({
      userId: id,
      roles: ['master'],
      revision: id,
      revokedSessions: 0,
      remainingSessions: 0,
    }))
    await expect(runAuthAdmin(port, roles, authority)).rejects.toThrow(
      /correspondem/,
    )
    await expect(
      runAuthAdmin(
        port,
        {
          operation: 'auth-sessions-revoke',
          environment: 'development',
          userId: id,
        },
        authority,
      ),
    ).resolves.toMatchObject({
      refreshSessionsRevoked: true,
      accessTokensMayRemainValid: true,
    })
    delete port.roles
    await expect(runAuthAdmin(port, roles, authority)).rejects.toThrow(
      /Executor/,
    )
    delete port.revokeSessions
    await expect(
      runAuthAdmin(
        port,
        {
          operation: 'auth-sessions-revoke',
          environment: 'development',
          userId: id,
        },
        authority,
      ),
    ).rejects.toThrow(/Executor/)
  })
  it('checks live session and revision in addition to authenticated JWT role claims', () => {
    const appMetadata = { supremo: { roles: ['editor'], roles_revision: id } }
    const input = {
      verifiedJwt: { sub: id, session_id: session, app_metadata: appMetadata },
      current: { userId: id, sessionId: session, active: true, appMetadata },
      requiredRole: 'editor',
    }
    expect(currentApplicationRole(input)).toBe(true)
    for (const current of [
      { ...input.current, active: false },
      { ...input.current, userId: session },
      { ...input.current, sessionId: id },
      {
        ...input.current,
        appMetadata: {
          supremo: { roles: ['editor'], roles_revision: session },
        },
      },
    ])
      expect(currentApplicationRole({ ...input, current })).toBe(false)
    expect(currentApplicationRole({ ...input, requiredRole: 'master' })).toBe(
      false,
    )
    expect(
      currentApplicationRole({
        ...input,
        verifiedJwt: { user_metadata: appMetadata },
      }),
    ).toBe(false)
  })
  it('generates only the fixed owner-authorized auth primitive and merges unrelated metadata atomically', () => {
    const sql = authAdministrationSql(id, ['editor'])
    expect(sql).toContain('pg_catalog.jsonb_set')
    expect(sql).toContain(
      "COALESCE(raw_app_meta_data->'supremo','{}'::jsonb)||",
    )
    expect(sql).toContain(`WHERE user_id='${id}'`)
    expect(sql).toContain(
      'LOCK TABLE auth.users,auth.sessions,auth.refresh_tokens',
    )
    expect(authAdministrationSql(id)).not.toContain('UPDATE auth.users')
    expect(() =>
      authAdministrationSql("';DELETE FROM auth.users;--", ['editor']),
    ).toThrow()
  })
  it('configures and confirms exact redirect URLs without provider credentials', async () => {
    const port = provider()
    port.management = vi
      .fn()
      .mockResolvedValueOnce({
        mailer_autoconfirm: false,
        disable_signup: false,
        uri_allow_list: '',
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        mailer_autoconfirm: false,
        disable_signup: false,
        uri_allow_list:
          'https://app.example/auth/callback,http://localhost:3000/auth/callback',
      })
    await expect(
      runAuthAdmin(port, {
        operation: 'auth-configure',
        environment: 'development',
        config: {
          redirectUrls: [
            'https://app.example/auth/callback',
            'http://localhost:3000/auth/callback',
          ],
        },
      }),
    ).resolves.toMatchObject({ verified: true })
    expect(port.management).toHaveBeenCalledWith('config/auth', 'PATCH', {
      uri_allow_list:
        'https://app.example/auth/callback,http://localhost:3000/auth/callback',
    })
    expect(
      authOptionsSchema.safeParse({
        operation: 'auth-configure',
        environment: 'development',
        config: { redirectUrls: ['https://user:password@app.example'] },
      }).success,
    ).toBe(false)
  })
})
