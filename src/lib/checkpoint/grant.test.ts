import { describe, expect, it } from 'vitest'
import {
  authorizePushGrant,
  decideTokenPermissions,
  diffTouchesWorkflows,
  type GrantProject,
} from './grant'

const project = (over: Partial<GrantProject> = {}): GrantProject => ({
  id: 'proj-A',
  userId: 'user-1',
  repoFullName: 'Hijaziia/app-a',
  ownerLogin: 'Hijaziia',
  ownerType: 'organization',
  defaultBranch: 'main',
  ...over,
})

describe('permissões mínimas do token', () => {
  it('diff normal → contents:write apenas (teste 6)', () => {
    expect(decideTokenPermissions(['app/page.tsx', 'app/globals.css'])).toEqual({
      contents: 'write',
    })
  })
  it('diff que mexe em workflows → +workflows:write (teste 7)', () => {
    expect(diffTouchesWorkflows(['.github/workflows/ci.yml'])).toBe(true)
    expect(
      decideTokenPermissions(['app/page.tsx', '.github/workflows/ci.yml']),
    ).toEqual({ contents: 'write', workflows: 'write' })
  })
  it('não confunde outros paths .github com workflows', () => {
    expect(diffTouchesWorkflows(['.github/dependabot.yml'])).toBe(false)
    expect(decideTokenPermissions(['.github/dependabot.yml'])).toEqual({
      contents: 'write',
    })
  })
})

describe('authorizePushGrant — fail-closed', () => {
  it('device do dono + projeto certo + repo → autoriza com permissões mínimas', () => {
    const d = authorizePushGrant({
      device: { ownerUserId: 'user-1' },
      project: project(),
      requestedProjectId: 'proj-A',
      changedPaths: ['app/page.tsx'],
    })
    expect(d).toMatchObject({
      ok: true,
      repoFullName: 'Hijaziia/app-a',
      ownerLogin: 'Hijaziia',
      permissions: { contents: 'write' },
    })
  })

  it('grant de A não serve para outro projeto pedido (teste 5)', () => {
    const d = authorizePushGrant({
      device: { ownerUserId: 'user-1' },
      project: project({ id: 'proj-A' }),
      requestedProjectId: 'proj-B',
      changedPaths: [],
    })
    expect(d).toEqual({ ok: false, reason: 'project_mismatch' })
  })

  it('device de outro dono → recusa (teste 4/5)', () => {
    const d = authorizePushGrant({
      device: { ownerUserId: 'intruso' },
      project: project(),
      requestedProjectId: 'proj-A',
      changedPaths: [],
    })
    expect(d).toEqual({ ok: false, reason: 'device_owner_mismatch' })
  })

  it('projeto sem repo provisionado → recusa', () => {
    const d = authorizePushGrant({
      device: { ownerUserId: 'user-1' },
      project: project({ repoFullName: null }),
      requestedProjectId: 'proj-A',
      changedPaths: [],
    })
    expect(d).toEqual({ ok: false, reason: 'repo_not_provisioned' })
  })

  it('owner pessoal antigo (login null) resolve pelo repoFullName', () => {
    const d = authorizePushGrant({
      device: { ownerUserId: 'user-1' },
      project: project({
        ownerLogin: null,
        ownerType: null,
        repoFullName: 'ahmedhijazi94/app',
      }),
      requestedProjectId: 'proj-A',
      changedPaths: [],
    })
    expect(d).toMatchObject({ ok: true, ownerLogin: 'ahmedhijazi94', ownerType: 'personal' })
  })
})
