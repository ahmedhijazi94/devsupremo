import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ get: vi.fn(), updateChecks: vi.fn(), updateProtection: vi.fn(), graphql: vi.fn() }))
vi.mock('@octokit/rest', () => ({ Octokit: class {
  repos = { getBranchProtection: mocks.get, updateStatusCheckProtection: mocks.updateChecks, updateBranchProtection: mocks.updateProtection }
  graphql = mocks.graphql
} }))
import { ensureRequiredBranchChecks, disableNativeAutoMerge } from './client'
import { githubMergeGateway } from './gateway'

const creds = { owner: 'owner', repo: 'app', repoFullName: 'owner/app', token: 'fixture', branch: 'work', defaultBranch: 'main' }
const required = ['Types', 'Tests', 'Isolation']

describe('GitHub protection remains complete without clearing custom controls', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.get.mockResolvedValue({ data: { required_status_checks: {
      strict: true, contexts: ['Company approval', 'Types'], checks: [{ context: 'Company approval', app_id: 1234 }],
    }, required_pull_request_reviews: { required_approving_review_count: 2 } } })
    mocks.updateChecks.mockResolvedValue({})
  })
  it('updates only required-check settings and preserves strictness, app binding and extra check', async () => {
    await ensureRequiredBranchChecks(creds, 'main', required)
    expect(mocks.updateProtection).not.toHaveBeenCalled()
    expect(mocks.updateChecks).toHaveBeenCalledWith({ owner: 'owner', repo: 'app', branch: 'main', strict: true, checks: [
      { context: 'Company approval', app_id: 1234 }, { context: 'Types', app_id: -1 },
      { context: 'Tests', app_id: -1 }, { context: 'Isolation', app_id: -1 },
    ] })
  })
  it('only creates protection when the prior protection does not exist', async () => {
    mocks.get.mockRejectedValueOnce({ status: 404 })
    await ensureRequiredBranchChecks(creds, 'main', required)
    expect(mocks.updateProtection).toHaveBeenCalledWith(expect.objectContaining({ required_status_checks: { strict: false, contexts: required } }))
    mocks.updateProtection.mockClear()
    mocks.get.mockRejectedValueOnce({ status: 403 })
    await expect(ensureRequiredBranchChecks(creds, 'main', required)).rejects.toEqual({ status: 403 })
    expect(mocks.updateProtection).not.toHaveBeenCalled()
  })
  it('native verification is read-only and rejects incomplete or unavailable protection', async () => {
    const gw = githubMergeGateway(creds)
    expect(await gw.hasRequiredChecks?.(required)).toBe(false)
    mocks.get.mockResolvedValueOnce({ data: { required_status_checks: { contexts: [...required, 'Extra'] } } })
    expect(await gw.hasRequiredChecks?.(required)).toBe(true)
    mocks.get.mockRejectedValueOnce(new Error('offline'))
    expect(await gw.hasRequiredChecks?.(required)).toBe(false)
    expect(mocks.updateChecks).not.toHaveBeenCalled()
    expect(mocks.updateProtection).not.toHaveBeenCalled()
  })
  it('withdrawal requests the exact pull request and reports failures', async () => {
    mocks.graphql.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('permission denied'))
    expect(await disableNativeAutoMerge(creds, 'PR_one')).toBe(true)
    expect(mocks.graphql).toHaveBeenCalledWith(expect.stringContaining('disablePullRequestAutoMerge'), { pr: 'PR_one' })
    expect(await disableNativeAutoMerge(creds, 'PR_two')).toBe(false)
  })
})
