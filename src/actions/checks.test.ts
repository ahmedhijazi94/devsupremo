import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CI_JOB_NAMES } from '@/lib/templates/project-files'

const mocks = vi.hoisted(() => ({ owner: vi.fn(), token: vi.fn(), pr: vi.fn(), checks: vi.fn(), merge: vi.fn(), history: vi.fn(), head: vi.fn(), open: vi.fn() }))
vi.mock('@/lib/auth', () => ({ requireProjectOwner: mocks.owner, toActionError: (error: unknown) => String(error) }))
vi.mock('@/lib/github-token', () => ({ freshGithubToken: mocks.token }))
vi.mock('@/actions/checkpoints', () => ({ listProjectCheckpoints: mocks.history }))
vi.mock('@/lib/github/client', () => ({
  getPullRequest: mocks.pr, getChecks: mocks.checks, mergePullRequest: mocks.merge,
  closePullRequest: vi.fn(), deleteBranch: vi.fn(), getHeadSha: mocks.head, getFailedJobLogs: vi.fn(), listOpenPullRequests: mocks.open,
  allowAutoMerge: vi.fn(), enableNativeAutoMerge: vi.fn(), disableNativeAutoMerge: vi.fn(), octokitFor: vi.fn(),
}))
import { getProjectChecks, mergeProjectPr } from './checks'

const projectId = '11111111-1111-4111-8111-111111111111'
const head = 'a'.repeat(40)
const checks = () => CI_JOB_NAMES.map((name) => ({ name, status: 'completed', conclusion: 'success' }))
const pr = (sha = head) => ({ headSha: sha, headRef: 'supremo/cp-one', nodeId: 'PR_one', state: 'open', merged: false })

describe('manual merge uses complete CI proof for the exact current HEAD', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    const account = { select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn(async () => ({ data: { access_token_encrypted: 'encrypted' } })) }
    account.select.mockReturnValue(account); account.eq.mockReturnValue(account)
    mocks.owner.mockResolvedValue({ user: { id: 'owner' }, supabase: { from: vi.fn(() => account) }, project: {
      github_repo_full_name: 'owner/app', github_account_id: 'account', active_branch: 'supremo/cp-one', default_branch: 'main',
    } })
    mocks.token.mockResolvedValue('token-fixture')
    mocks.pr.mockResolvedValue(pr())
    // A green generic summary cannot replace required-check validation.
    mocks.checks.mockResolvedValue({ state: 'passed', headSha: head, checks: checks() })
    mocks.merge.mockResolvedValue({ sha: head })
    mocks.history.mockResolvedValue({ items: [] })
    mocks.head.mockResolvedValue(head)
    mocks.open.mockResolvedValue([])
  })
  it('passes the independently reread HEAD as GitHub expectedSha', async () => {
    expect(await mergeProjectPr(projectId, 1)).toEqual({ ok: true })
    expect(mocks.pr).toHaveBeenCalledTimes(2)
    expect(mocks.merge).toHaveBeenCalledWith(expect.anything(), 1, undefined, head)
  })
  it.each(['missing', 'skipped', 'neutral', 'failure', 'queued'])('refuses %s required checks despite a green summary', async (state) => {
    const actual = checks()
    if (state === 'missing') actual.pop()
    else actual[0] = { name: CI_JOB_NAMES[0], status: state === 'queued' ? 'queued' : 'completed', conclusion: state }
    mocks.checks.mockResolvedValue({ state: 'passed', headSha: head, checks: actual })
    expect((await mergeProjectPr(projectId, 1)).error).toBeTruthy()
    expect(mocks.merge).not.toHaveBeenCalled()
  })
  it('refuses no checks and checks from another SHA', async () => {
    mocks.checks.mockResolvedValueOnce({ state: 'passed', headSha: head, checks: [] })
      .mockResolvedValueOnce({ state: 'passed', headSha: 'b'.repeat(40), checks: checks() })
    expect((await mergeProjectPr(projectId, 1)).error).toBeTruthy()
    expect((await mergeProjectPr(projectId, 1)).error).toBeTruthy()
    expect(mocks.merge).not.toHaveBeenCalled()
  })
  it('refuses a HEAD change between validation and merge', async () => {
    mocks.pr.mockResolvedValueOnce(pr()).mockResolvedValueOnce(pr('b'.repeat(40)))
    expect((await mergeProjectPr(projectId, 1)).error).toContain('HEAD mudou')
    expect(mocks.merge).not.toHaveBeenCalled()
  })
  it('the project badge never treats a partial green check set as all gates passed', async () => {
    mocks.checks.mockResolvedValue({ state: 'passed', headSha: head, total: 1, checks: [checks()[0]] })
    const result = await getProjectChecks(projectId)
    expect(result.data?.state).toBe('pending')
    expect(result.data?.summary).toContain('6 gate(s) ainda não recebido(s)')
  })
  it('the project badge distinguishes skipped gates and exact-HEAD success', async () => {
    const actual = checks(); actual[0]!.conclusion = 'skipped'
    mocks.checks.mockResolvedValueOnce({ state: 'passed', headSha: head, checks: actual })
    expect((await getProjectChecks(projectId)).data?.state).toBe('failed')
    expect((await getProjectChecks(projectId)).data?.state).toBe('passed')
  })
  it('the project badge detects a newer HEAD and preserves local-failure precedence', async () => {
    mocks.head.mockResolvedValueOnce(head).mockResolvedValueOnce('b'.repeat(40))
    expect((await getProjectChecks(projectId)).data?.state).toBe('pending')
    mocks.history.mockResolvedValue({ items: [{ localState: 'failed', validationSummary: 'Falha local', validationLabel: 'Pendência local' }] })
    mocks.checks.mockClear()
    expect((await getProjectChecks(projectId)).data).toMatchObject({ state: 'failed', source: 'Computador de desenvolvimento' })
    expect(mocks.checks).not.toHaveBeenCalled()
  })
  it('does not reach GitHub without project ownership', async () => {
    mocks.owner.mockRejectedValue(new Error('not authorized'))
    expect((await mergeProjectPr(projectId, 1)).error).toBeTruthy()
    expect(mocks.pr).not.toHaveBeenCalled()
    expect(mocks.merge).not.toHaveBeenCalled()
  })
})
