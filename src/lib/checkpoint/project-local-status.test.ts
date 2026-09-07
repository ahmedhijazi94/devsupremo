import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ history: vi.fn(), github: vi.fn(), owner: vi.fn() }))
vi.mock('@/actions/checkpoints', () => ({ listProjectCheckpoints: mocks.history }))
vi.mock('@/lib/auth', () => ({ requireProjectOwner: mocks.owner, toActionError: () => 'error' }))
vi.mock('@/lib/github/client', () => ({ listOpenPullRequests: mocks.github }))
import { getProjectChecks } from '@/actions/checks'

describe('project status respects work that has not reached GitHub', () => {
  beforeEach(() => { vi.clearAllMocks() })
  it.each(['pending', 'failed'] as const)('shows the local %s state before any previous scaffold green checks', async (state) => {
    mocks.history.mockResolvedValue({ items: [{ id: 'local', localState: state, validationLabel: 'Estado local', validationSummary: 'Aguardando publicação' }] })
    const result = await getProjectChecks('11111111-1111-4111-8111-111111111111')
    expect(result.data).toMatchObject({ state, badgeLabel: 'Estado local', prNumber: null, checks: [], summary: 'Aguardando publicação' })
    expect(mocks.github).not.toHaveBeenCalled()
    expect(mocks.owner).not.toHaveBeenCalled()
  })
  it('unknown local state cannot fall back to a misleading green badge', async () => {
    mocks.history.mockResolvedValue({ error: 'database unavailable' })
    expect(await getProjectChecks('11111111-1111-4111-8111-111111111111')).toHaveProperty('error')
    expect(mocks.github).not.toHaveBeenCalled()
  })
})
