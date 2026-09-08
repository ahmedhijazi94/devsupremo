import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildProjectFiles } from '../templates/project-files'
import { blobHash } from '../../../packages/cli/src/validation-integrity'

const mocks = vi.hoisted(() => ({
  runs: vi.fn(), jobs: vi.fn(), tree: vi.fn(), read: vi.fn(), project: vi.fn(), worker: vi.fn(),
  checks: vi.fn(), setup: vi.fn(), repository: vi.fn(),
}))
vi.mock('./client', () => ({
  octokitFor: () => ({ actions: { listWorkflowRuns: mocks.runs, listJobsForWorkflowRun: mocks.jobs },
    paginate: (method: unknown, options: unknown) => method === mocks.jobs ? mocks.jobs(method, options) : mocks.checks(method, options),
    checks: { listForRef: mocks.checks }, codeScanning: { getDefaultSetup: mocks.setup }, repos: { get: mocks.repository }, git: { getTree: mocks.tree } }),
  readFile: mocks.read,
  allowAutoMerge: vi.fn(), deleteBranch: vi.fn(), disableNativeAutoMerge: vi.fn(), enableNativeAutoMerge: vi.fn(), getPullRequest: vi.fn(), mergePullRequest: vi.fn(),
}))
vi.mock('../projects/repository', () => ({ getProject: mocks.project, getProjectByRepoFullName: mocks.worker }))
import { githubMergeGateway } from './gateway'

const creds = { owner: 'owner', repo: 'app', repoFullName: 'owner/app', token: 'fixture', branch: 'work', defaultBranch: 'main' }
const SHA = 'a'.repeat(40)

describe('GitHub adapter binds policy and job evidence to the immutable revision', () => {
  beforeEach(() => { vi.clearAllMocks() })
  it('reads project kind from the control plane and candidate files at the same SHA', async () => {
    const files = buildProjectFiles({ projectName: 'real-app', description: '', kind: 'solo' })
    mocks.worker.mockResolvedValue({ id: 'project', userId: 'owner' })
    mocks.project.mockResolvedValue({ kind: 'solo' })
    mocks.tree.mockResolvedValue({ data: { truncated: false, tree: files.map(file => ({ path: file.path, sha: blobHash(file.content), mode: '100644', type: 'blob' })) } })
    mocks.read.mockImplementation(async (_creds, path: string) => files.find(file => file.path === path)!.content)
    const authority = await githubMergeGateway(creds).verifyPolicy!(SHA)
    expect(authority.approved).toBe(true)
    expect(mocks.project).toHaveBeenCalledWith('owner', 'project')
    expect(mocks.tree).toHaveBeenCalledWith(expect.objectContaining({ tree_sha: SHA }))
    expect(mocks.read).toHaveBeenCalledWith(creds, 'package.json', SHA)
    expect(mocks.read).toHaveBeenCalledWith(creds, 'package-lock.json', SHA)
  })
  it('does not inspect or approve an unregistered repository', async () => {
    mocks.worker.mockResolvedValue(null)
    expect((await githubMergeGateway(creds).verifyPolicy!(SHA)).approved).toBe(false)
    expect(mocks.tree).not.toHaveBeenCalled()
  })
  it('retrieves jobs from the current trusted run only, with pagination and latest attempts', async () => {
    mocks.runs.mockResolvedValue({ data: { workflow_runs: [
      { id: 9, head_sha: SHA, path: '.github/workflows/ci.yml', event: 'pull_request', run_number: 9, status: 'in_progress', conclusion: null },
      { id: 10, head_sha: SHA, path: '.github/workflows/fake.yml', event: 'pull_request', run_number: 10, status: 'completed', conclusion: 'success' },
    ] } })
    const jobs = [{ name: 'Tests', status: 'in_progress', conclusion: null }]
    mocks.jobs.mockResolvedValue(jobs)
    expect(await githubMergeGateway(creds).getChecks(SHA)).toEqual({ headSha: SHA, checks: jobs })
    expect(mocks.runs).toHaveBeenCalledWith(expect.objectContaining({ workflow_id: 'ci.yml', head_sha: SHA }))
    expect(mocks.jobs).toHaveBeenCalledWith(mocks.jobs, expect.objectContaining({ run_id: 9, filter: 'latest' }))
    mocks.runs.mockResolvedValueOnce({ data: { workflow_runs: [] } })
    expect(await githubMergeGateway(creds).getChecks(SHA)).toEqual({ headSha: SHA, checks: [] })
  })
  it('paginates all check attempts separately from workflow jobs and verifies provider configuration', async () => {
    mocks.setup.mockResolvedValue({ data: { state: 'configured' } })
    mocks.checks.mockResolvedValue([
      { id: 10, name: 'CodeQL', head_sha: SHA, status: 'completed', conclusion: 'failure', app: { id: 57789, slug: 'github-advanced-security', owner: { login: 'github' } } },
      { id: 99, name: 'CodeQL', head_sha: SHA, status: 'completed', conclusion: 'success', app: { id: 1, slug: 'github-advanced-security', owner: { login: 'github' } } },
    ])
    expect(await githubMergeGateway(creds).getCodeScanning!(SHA)).toMatchObject({ headSha: SHA, status: 'failed' })
    expect(mocks.checks).toHaveBeenCalledWith(mocks.checks, { owner: 'owner', repo: 'app', ref: SHA, filter: 'all', per_page: 100 })
    expect(mocks.setup).toHaveBeenCalledWith({ owner: 'owner', repo: 'app' })
    expect(mocks.jobs).not.toHaveBeenCalled()
    expect(mocks.repository).not.toHaveBeenCalled()
  })
  it('requires positive repository metadata after an unavailable default setup response', async () => {
    mocks.setup.mockRejectedValue({ status: 403 })
    mocks.checks.mockResolvedValue([])
    mocks.repository.mockResolvedValue({ data: { private: true, security_and_analysis: {
      code_security: { status: 'disabled' }, advanced_security: { status: 'disabled' },
    } } })
    expect((await githubMergeGateway(creds).getCodeScanning!(SHA)).status).toBe('not_required')
    expect(mocks.repository).toHaveBeenCalledWith({ owner: 'owner', repo: 'app' })
    mocks.checks.mockRejectedValueOnce(new Error('GitHub unavailable'))
    expect((await githubMergeGateway(creds).getCodeScanning!(SHA)).status).toBe('unavailable')
  })
})
