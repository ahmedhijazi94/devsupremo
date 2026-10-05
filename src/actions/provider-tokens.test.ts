import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NEXT_TEMPLATE_VERSION } from '@/lib/templates/stacks'

const mocks = vi.hoisted(() => ({
  owner: vi.fn(), token: vi.fn(), tree: vi.fn(), tables: vi.fn(), functions: vi.fn(),
  protection: vi.fn(), plan: vi.fn(), from: vi.fn(),
}))
vi.mock('@/lib/auth', () => ({
  requireProjectOwner: mocks.owner,
  toActionError: (error: unknown) => error instanceof Error ? error.message : 'Erro inesperado.',
}))
vi.mock('@/lib/account-tokens/server', () => ({ getAccountToken: mocks.token }))
vi.mock('@/lib/github/client', () => ({
  listTree: mocks.tree, ensureRequiredBranchChecks: mocks.protection,
  commitFiles: vi.fn(), ensureBranch: vi.fn(), openOrUpdatePullRequest: vi.fn(),
  readFile: vi.fn(), listOpenPullRequests: vi.fn(), resetBranchToBase: vi.fn(),
}))
vi.mock('@/lib/db-introspect', () => ({
  listTables: mocks.tables, listEdgeFunctions: mocks.functions,
  tableColumns: vi.fn(), tablePolicies: vi.fn(), tableRows: vi.fn(), safeIdent: vi.fn(),
}))
vi.mock('@/lib/templates/sync', () => ({
  planTemplateSync: mocks.plan, planIsEmpty: () => true, planToFileChanges: vi.fn(),
}))

import { getRepoTree } from './code'
import { getDatabaseOverview } from './database'
import { setFastMode } from './fast-mode'
import { getAppRoutes } from './routes'
import { getTemplateSyncStatus } from './template-sync'

const projectId = '11111111-1111-4111-8111-111111111111'
const ownerId = 'owner-session'
const renewedToken = 'renewed-provider-token'

beforeEach(() => {
  vi.resetAllMocks()
  const query = { update: () => query, eq: () => query }
  mocks.from.mockImplementation((table: string) => {
    if (table !== 'projects') throw new Error('Actions must delegate account token reads.')
    return query
  })
  mocks.owner.mockResolvedValue({
    user: { id: ownerId }, supabase: { from: mocks.from },
    project: {
      id: projectId, user_id: ownerId, name: 'app', description: '', kind: 'solo',
      github_account_id: 'github-account', github_repo_full_name: 'owner/app',
      supabase_account_id: 'supabase-account', supabase_project_ref: 'app-ref',
      default_branch: 'main', template_version: NEXT_TEMPLATE_VERSION,
    },
  })
  mocks.token.mockResolvedValue(renewedToken)
  mocks.tree.mockResolvedValue([{ path: 'app/page.tsx' }])
  mocks.tables.mockResolvedValue([])
  mocks.functions.mockResolvedValue([])
  mocks.plan.mockResolvedValue({ templateVersion: NEXT_TEMPLATE_VERSION, updates: [], creates: [], skipped: [] })
})

const operations = [
  { name: 'route discovery', provider: 'github', run: () => getAppRoutes(projectId), boundary: mocks.tree },
  { name: 'code browsing', provider: 'github', run: () => getRepoTree(projectId), boundary: mocks.tree },
  { name: 'branch protection', provider: 'github', run: () => setFastMode({ projectId, fastMode: true, rlsMode: 'block' }), boundary: mocks.protection },
  { name: 'template comparison', provider: 'github', run: () => getTemplateSyncStatus(projectId), boundary: mocks.plan },
  { name: 'database browsing', provider: 'supabase', run: () => getDatabaseOverview(projectId), boundary: mocks.tables },
] as const

describe.each(operations)('$name account token boundary', ({ provider, run, boundary }) => {
  it('uses the centrally resolved token and authenticated owner without loading an old token snapshot', async () => {
    const result = await run()
    expect(result.error).toBeUndefined()
    expect(mocks.token).toHaveBeenCalledExactlyOnceWith({ provider, accountId: `${provider}-account`, userId: ownerId })
    if (provider === 'supabase') expect(boundary).toHaveBeenCalledWith(renewedToken, 'app-ref')
    else expect(boundary.mock.calls[0]?.[0]).toMatchObject({ token: renewedToken, repoFullName: 'owner/app' })
    expect(JSON.stringify(result)).not.toContain(renewedToken)
  })

  it('rejects a foreign project before resolving a token or calling the provider', async () => {
    mocks.owner.mockRejectedValue(new Error('Projeto não encontrado.'))
    expect((await run()).error).toBe('Projeto não encontrado.')
    expect(mocks.token).not.toHaveBeenCalled()
    expect(boundary).not.toHaveBeenCalled()
  })

  it('does not fall back to a stale token when renewal is unavailable', async () => {
    mocks.token.mockRejectedValue(new Error('Reconecte sua conta.'))
    expect((await run()).error).toBe('Reconecte sua conta.')
    expect(boundary).not.toHaveBeenCalled()
  })
})
