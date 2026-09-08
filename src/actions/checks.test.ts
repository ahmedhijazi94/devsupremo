import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CI_JOB_NAMES } from '@/lib/templates/project-files'

const mocks = vi.hoisted(() => ({ owner: vi.fn(), token: vi.fn(), pr: vi.fn(), checks: vi.fn(), merge: vi.fn(), history: vi.fn(), head: vi.fn(), open: vi.fn(), policy: vi.fn(), checkpoint: vi.fn() }))
vi.mock('@/lib/auth', () => ({ requireProjectOwner: mocks.owner, toActionError: (error: unknown) => String(error) }))
vi.mock('@/lib/github-token', () => ({ freshGithubToken: mocks.token }))
vi.mock('@/actions/checkpoints', () => ({ listProjectCheckpoints: mocks.history }))
vi.mock('@/lib/github/client', () => ({
  getPullRequest: mocks.pr, getChecks: mocks.checks, mergePullRequest: mocks.merge,
  closePullRequest: vi.fn(), deleteBranch: vi.fn(), getHeadSha: mocks.head, getFailedJobLogs: vi.fn(), listOpenPullRequests: mocks.open,
  allowAutoMerge: vi.fn(), enableNativeAutoMerge: vi.fn(), disableNativeAutoMerge: vi.fn(), octokitFor: vi.fn(),
}))
vi.mock('@/lib/github/gateway', () => ({ githubMergeGateway: (creds: unknown) => ({
  getPullRequest: (number: number) => mocks.pr(creds, number),
  getChecks: (sha: string) => mocks.checks(creds, sha),
  getCodeScanning: async (headSha: string) => ({ headSha, status: 'not_required', reasons: ['Default setup confirmed not configured.'] }),
  verifyPolicy: mocks.policy,
  merge: (number: number, sha: string) => mocks.merge(creds, number, undefined, sha),
}) }))
import { getProjectChecks, mergeProjectPr } from './checks'

const projectId = '11111111-1111-4111-8111-111111111111'
const head = 'a'.repeat(40)
const checks = () => CI_JOB_NAMES.map((name) => ({ name, status: 'completed', conclusion: 'success' }))
const pr = (sha = head) => ({ headSha: sha, headRef: 'supremo/cp-one', nodeId: 'PR_one', state: 'open', merged: false })
const blockedCheckpoint = { id: 'checkpoint-current', project_id: projectId, pr_number: 1, published_sha: head, push_status: 'published', integration_status: 'security_blocked' }

function checkpointQuery() {
  const filters: Array<[string, unknown]> = []
  const query = {
    select: () => query,
    eq: (column: string, value: unknown) => { filters.push([column, value]); return query },
    maybeSingle: async () => {
      const row = mocks.checkpoint() as Record<string, unknown> | null
      return { data: row && filters.every(([column, value]) => row[column] === value) ? row : null, error: null }
    },
  }
  return query
}

describe('manual merge uses complete CI proof for the exact current HEAD', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    const account = { select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn(async () => ({ data: { access_token_encrypted: 'encrypted' } })) }
    account.select.mockReturnValue(account); account.eq.mockReturnValue(account)
    mocks.owner.mockResolvedValue({ user: { id: 'owner' }, supabase: { from: vi.fn((table: string) => table === 'checkpoints' ? checkpointQuery() : account) }, project: {
      github_repo_full_name: 'owner/app', github_account_id: 'account', active_branch: 'supremo/cp-one', default_branch: 'main',
    } })
    mocks.token.mockResolvedValue('token-fixture')
    mocks.pr.mockResolvedValue(pr())
    // A green generic summary cannot replace required-check validation.
    mocks.checks.mockResolvedValue({ state: 'passed', headSha: head, checks: checks() })
    mocks.merge.mockResolvedValue({ sha: head })
    mocks.policy.mockResolvedValue({ approved: true, headSha: head, reasons: [] })
    mocks.history.mockResolvedValue({ items: [] })
    mocks.head.mockResolvedValue(head)
    mocks.open.mockResolvedValue([])
    mocks.checkpoint.mockReturnValue(null)
  })
  it('passes the independently reread HEAD as GitHub expectedSha', async () => {
    expect(await mergeProjectPr(projectId, 1)).toEqual({ ok: true })
    expect(mocks.pr).toHaveBeenCalledTimes(2)
    expect(mocks.merge).toHaveBeenCalledWith(expect.anything(), 1, undefined, head)
  })
  it('refuses altered validation policy even when every check is green', async () => {
    mocks.policy.mockResolvedValue({ approved: false, headSha: head, reasons: ['Validador alterado.'] })
    expect((await mergeProjectPr(projectId, 1)).error).toContain('Validador alterado')
    expect(mocks.merge).not.toHaveBeenCalled()
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
  it.each(['Falhou', 'Integração bloqueada'])('same-revision %s integration status overrides the badge without hiding successful CI checks', async (status) => {
    mocks.open.mockResolvedValue([{ ...pr(), number: 1, isAgentWork: true }])
    mocks.history.mockResolvedValue({ items: [{ id: blockedCheckpoint.id, prNumber: 1, status }] })
    mocks.checkpoint.mockReturnValue(blockedCheckpoint)
    const result = await getProjectChecks(projectId)
    expect(result.data).toMatchObject({ state: 'failed', badgeLabel: 'Integração bloqueada', prNumber: 1 })
    expect(result.data?.summary).toContain('verificações obrigatórias do GitHub foram aprovadas')
    expect(result.data?.summary).toContain('A integração desta versão está bloqueada')
    expect(result.data?.checks).toHaveLength(CI_JOB_NAMES.length)
    expect(result.data?.checks.every(check => check.conclusion === 'success')).toBe(true)
    expect(mocks.merge).not.toHaveBeenCalled()
  })
  it.each([
    { published_sha: 'b'.repeat(40) }, { id: 'another-checkpoint' },
    { project_id: '22222222-2222-4222-8222-222222222222' }, { pr_number: 2 },
    { integration_status: 'validated' },
  ])('does not apply stale, unrelated or already cleared integration blocks (%j)', async (difference) => {
    mocks.open.mockResolvedValue([{ ...pr(), number: 1, isAgentWork: true }])
    mocks.history.mockResolvedValue({ items: [{ id: blockedCheckpoint.id, prNumber: 1, status: 'Falhou' }] })
    mocks.checkpoint.mockReturnValue({ ...blockedCheckpoint, ...difference })
    const result = await getProjectChecks(projectId)
    expect(result.data).toMatchObject({ state: 'passed' })
    expect(result.data?.badgeLabel).toBeUndefined()
  })
  it('ignores failures of older history items or another PR, and does not attach them to main after merge', async () => {
    const old = { id: blockedCheckpoint.id, prNumber: 1, status: 'Falhou' }
    mocks.open.mockResolvedValue([{ ...pr(), number: 1, isAgentWork: true }])
    mocks.history.mockResolvedValue({ items: [{ id: 'new-checkpoint', prNumber: 1, status: 'Aguardando integração' }, old] })
    expect((await getProjectChecks(projectId)).data?.state).toBe('passed')
    mocks.history.mockResolvedValue({ items: [{ ...old, prNumber: 2 }] })
    expect((await getProjectChecks(projectId)).data?.state).toBe('passed')
    mocks.history.mockResolvedValue({ items: [old] })
    mocks.open.mockResolvedValue([])
    expect((await getProjectChecks(projectId)).data?.state).toBe('passed')
    expect(mocks.checkpoint).not.toHaveBeenCalled()
  })
  it('does not fall back to a green badge when the current integration block cannot be confirmed', async () => {
    mocks.open.mockResolvedValue([{ ...pr(), number: 1, isAgentWork: true }])
    mocks.history.mockResolvedValue({ items: [{ id: blockedCheckpoint.id, prNumber: 1, status: 'Falhou' }] })
    mocks.checkpoint.mockImplementation(() => { throw new Error('checkpoint unavailable') })
    const result = await getProjectChecks(projectId)
    expect(result.error).toBeTruthy()
    expect(result.data).toBeUndefined()
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
