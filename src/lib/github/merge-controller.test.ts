import { describe, expect, it, vi } from 'vitest'
import { reconcileMerge, type MergeGateway } from './merge-controller'
import type { CheckRun } from './merge-policy'

const REQUIRED = ['Tipos, lint e auditoria', 'Build de produção']
const SHA = 'a'.repeat(40)
const SHA2 = 'b'.repeat(40)
const green: CheckRun[] = REQUIRED.map((name) => ({
  name,
  status: 'completed',
  conclusion: 'success',
}))

function gateway(over: Partial<MergeGateway> & { headSha?: string; checksHeadSha?: string } = {}): MergeGateway {
  const head = over.headSha ?? SHA
  return {
    getPullRequest: vi.fn(async () => ({
      headSha: head,
      headRef: 'supremo/cp-x',
      nodeId: 'PR_node',
      merged: false,
      state: 'open',
    })),
    getChecks: vi.fn(async () => ({ checks: green, headSha: over.checksHeadSha ?? head })),
    getCodeScanning: vi.fn(async (headSha: string) => ({ headSha, status: 'not_required' as const, reasons: ['Default setup confirmed not configured.'] })),
    verifyPolicy: vi.fn(async (headSha: string) => ({ approved: true, headSha, reasons: [] })),
    hasRequiredChecks: vi.fn(async () => true),
    allowAutoMerge: vi.fn(async () => true),
    enableNativeAutoMerge: vi.fn(async () => true),
    merge: vi.fn(async () => ({ sha: head })),
    deleteBranch: vi.fn(async () => {}),
    ...over,
  }
}

describe('reconcileMerge — modo NATIVE_GITHUB', () => {
  it('preserva proteção nativa e integra somente o SHA aprovado pelo motor', async () => {
    const gw = gateway()
    const r = await reconcileMerge(gw, { prNumber: 1, requiredChecks: REQUIRED, mode: 'native' })
    expect(gw.enableNativeAutoMerge).not.toHaveBeenCalled()
    expect(gw.allowAutoMerge).not.toHaveBeenCalled()
    expect(gw.merge).toHaveBeenCalledWith(1, SHA)
    expect(r.state).toBe('merged')
  })

  it('never arms native merge while any required check is absent', async () => {
    const gw = gateway({ getChecks: vi.fn(async () => ({ checks: [], headSha: SHA })) })
    expect((await reconcileMerge(gw, { prNumber: 1, requiredChecks: REQUIRED, mode: 'native' })).decision).toBe('wait')
    expect(gw.enableNativeAutoMerge).not.toHaveBeenCalled()
  })
  it('withdraws armed native merge when protection no longer contains every gate', async () => {
    const gw = gateway({
      hasRequiredChecks: vi.fn(async () => false),
      disableNativeAutoMerge: vi.fn(async () => true),
      getPullRequest: vi.fn(async () => ({ headSha: SHA, headRef: 'supremo/cp-x', nodeId: 'PR_node', merged: false, state: 'open', autoMergeEnabled: true })),
    })
    const result = await reconcileMerge(gw, { prNumber: 1, requiredChecks: REQUIRED, mode: 'native' })
    expect(result).toMatchObject({ state: 'security_blocked', decision: 'blocked', merged: false })
    expect(gw.disableNativeAutoMerge).toHaveBeenCalledWith('PR_node')
    expect(gw.enableNativeAutoMerge).not.toHaveBeenCalled()
  })
  it('reports failure to withdraw an unsafe native merge without claiming it stopped', async () => {
    const gw = gateway({
      hasRequiredChecks: vi.fn(async () => false), disableNativeAutoMerge: vi.fn(async () => false),
      getPullRequest: vi.fn(async () => ({ headSha: SHA, headRef: 'supremo/cp-x', nodeId: 'PR_node', merged: false, state: 'open', autoMergeEnabled: true })),
    })
    expect((await reconcileMerge(gw, { prNumber: 1, requiredChecks: REQUIRED, mode: 'native' })).reasons.join(' ')).toContain('não confirmou')
    expect(gw.enableNativeAutoMerge).not.toHaveBeenCalled()
  })
  it('does not arm native auto-merge after the HEAD changes', async () => {
    const gw = gateway()
    vi.mocked(gw.getPullRequest).mockResolvedValueOnce({ headSha: SHA, headRef: 'supremo/cp-x', nodeId: 'PR_node', merged: false, state: 'open' })
      .mockResolvedValueOnce({ headSha: SHA2, headRef: 'supremo/cp-x', nodeId: 'PR_node', merged: false, state: 'open' })
    expect((await reconcileMerge(gw, { prNumber: 1, requiredChecks: REQUIRED, mode: 'native' })).decision).toBe('wait')
    expect(gw.enableNativeAutoMerge).not.toHaveBeenCalled()
  })

  it('gate falho no nativo → não habilita e reporta o bloqueio', async () => {
    const gw = gateway({
      getChecks: vi.fn(async () => ({
        checks: [
          { name: REQUIRED[0]!, status: 'completed', conclusion: 'success' },
          { name: REQUIRED[1]!, status: 'completed', conclusion: 'failure' },
        ],
        headSha: SHA,
      })),
    })
    const r = await reconcileMerge(gw, { prNumber: 1, requiredChecks: REQUIRED, mode: 'native' })
    expect(gw.enableNativeAutoMerge).not.toHaveBeenCalled()
    expect(r.state).toBe('ci_failed')
    expect(r.headSha).toBe(SHA)
    expect(r.merged).toBe(false)
  })
})

describe('reconcileMerge — modo SUPREMO_MANAGED', () => {
  it.each(['pending', 'failed', 'unavailable'] as const)('does not merge when official CodeQL is %s despite every CI job passing', async status => {
    const gw = gateway({ getCodeScanning: vi.fn(async headSha => ({ headSha, status, reasons: ['CodeQL evidence'] })) })
    const result = await reconcileMerge(gw, { prNumber: 1, requiredChecks: REQUIRED, mode: 'supremo_managed' })
    expect(result.decision).toBe(status === 'pending' ? 'wait' : 'blocked')
    expect(gw.merge).not.toHaveBeenCalled()
  })
  it('fails closed for absent, stale or rejected CodeQL evidence in both merge modes', async () => {
    for (const mode of ['native', 'supremo_managed'] as const) {
      for (const getCodeScanning of [undefined, vi.fn(async () => ({ headSha: SHA2, status: 'passed' as const, reasons: [] })), vi.fn(async () => { throw new Error('GitHub unavailable') })]) {
        const gw = gateway(getCodeScanning ? { getCodeScanning } : {})
        if (!getCodeScanning) delete gw.getCodeScanning
        expect((await reconcileMerge(gw, { prNumber: 1, requiredChecks: REQUIRED, mode })).state).toBe('security_blocked')
        expect(gw.merge).not.toHaveBeenCalled()
      }
    }
  })
  it.each(['pending', 'failed', 'unavailable'] as const)('rechecks CodeQL next to merge and refuses a late %s result on the same HEAD', async status => {
    const getCodeScanning = vi.fn().mockResolvedValueOnce({ headSha: SHA, status: 'passed', reasons: [] })
      .mockResolvedValueOnce({ headSha: SHA, status, reasons: ['Late CodeQL result'] })
    const gw = gateway({ getCodeScanning })
    expect((await reconcileMerge(gw, { prNumber: 1, requiredChecks: REQUIRED, mode: 'supremo_managed' })).merged).toBe(false)
    expect(gw.verifyPolicy).toHaveBeenCalledWith(SHA)
    expect(getCodeScanning).toHaveBeenCalledTimes(2)
    expect(gw.merge).not.toHaveBeenCalled()
  })
  it('still requires all trusted CI jobs when official CodeQL passes', async () => {
    const gw = gateway({ getChecks: vi.fn(async () => ({ headSha: SHA, checks: [] })),
      getCodeScanning: vi.fn(async headSha => ({ headSha, status: 'passed' as const, reasons: [] })) })
    expect((await reconcileMerge(gw, { prNumber: 1, requiredChecks: REQUIRED, mode: 'supremo_managed' })).decision).toBe('wait')
    expect(gw.merge).not.toHaveBeenCalled()
  })
  it('disarms native merge before reading jobs and again if rearmed at a newer revision', async () => {
    const events: string[] = []
    const gw = gateway({
      disableNativeAutoMerge: vi.fn(async () => { events.push('disarm'); return true }),
      getChecks: vi.fn(async () => { events.push('checks'); return { checks: green, headSha: SHA } }),
      getPullRequest: vi.fn().mockResolvedValueOnce({ headSha: SHA, headRef: 'supremo/work', nodeId: 'PR', merged: false, state: 'open', autoMergeEnabled: true })
        .mockResolvedValueOnce({ headSha: SHA2, headRef: 'supremo/work', nodeId: 'PR', merged: false, state: 'open', autoMergeEnabled: true }),
    })
    expect((await reconcileMerge(gw, { prNumber: 1, requiredChecks: REQUIRED, mode: 'supremo_managed' })).decision).toBe('wait')
    expect(events).toEqual(['disarm', 'checks', 'disarm'])
    expect(gw.merge).not.toHaveBeenCalled()
  })
  it('blocks if native merge is rearmed and cannot be withdrawn', async () => {
    const gw = gateway({ disableNativeAutoMerge: vi.fn(async () => false) })
    vi.mocked(gw.getPullRequest).mockResolvedValueOnce({ headSha: SHA, headRef: 'supremo/work', nodeId: 'PR', merged: false, state: 'open' })
      .mockResolvedValueOnce({ headSha: SHA2, headRef: 'supremo/work', nodeId: 'PR', merged: false, state: 'open', autoMergeEnabled: true })
    expect((await reconcileMerge(gw, { prNumber: 1, requiredChecks: REQUIRED, mode: 'supremo_managed' })).state).toBe('security_blocked')
    expect(gw.merge).not.toHaveBeenCalled()
  })
  it.each(['native', 'supremo_managed'] as const)('fails closed in %s when policy is missing, altered, or for a stale SHA', async mode => {
    for (const proof of [undefined, { approved: false, headSha: SHA, reasons: ['Validador alterado.'] }, { approved: true, headSha: SHA2, reasons: [] }]) {
      const gw = gateway()
      if (proof) gw.verifyPolicy = vi.fn(async () => proof)
      else delete gw.verifyPolicy
      const result = await reconcileMerge(gw, { prNumber: 7, requiredChecks: REQUIRED, mode })
      expect(result.state).toBe('security_blocked')
      expect(gw.merge).not.toHaveBeenCalled()
      expect(gw.enableNativeAutoMerge).not.toHaveBeenCalled()
    }
  })
  it('mescla com o SHA ESPERADO quando tudo verde no HEAD atual', async () => {
    const gw = gateway()
    const r = await reconcileMerge(gw, { prNumber: 7, requiredChecks: REQUIRED, mode: 'supremo_managed' })
    expect(gw.merge).toHaveBeenCalledWith(7, SHA) // expectedSha = HEAD validado
    expect(r.merged).toBe(true)
    expect(r.state).toBe('merged')
    expect(r.headSha).toBe(SHA)
  })

  it('NÃO mescla se um check falhou', async () => {
    const gw = gateway({
      getChecks: vi.fn(async () => ({
        checks: [
          { name: REQUIRED[0]!, status: 'completed', conclusion: 'success' },
          { name: REQUIRED[1]!, status: 'completed', conclusion: 'failure' },
        ],
        headSha: SHA,
      })),
    })
    const r = await reconcileMerge(gw, { prNumber: 7, requiredChecks: REQUIRED, mode: 'supremo_managed' })
    expect(gw.merge).not.toHaveBeenCalled()
    expect(r.merged).toBe(false)
  })

  it('NÃO mescla se um required check está ausente', async () => {
    const gw = gateway({
      getChecks: vi.fn(async () => ({
        checks: [{ name: REQUIRED[0]!, status: 'completed', conclusion: 'success' }],
        headSha: SHA,
      })),
    })
    const r = await reconcileMerge(gw, { prNumber: 7, requiredChecks: REQUIRED, mode: 'supremo_managed' })
    expect(gw.merge).not.toHaveBeenCalled()
    expect(r.decision).toBe('wait')
  })

  it('anti-TOCTOU: HEAD muda entre validação e merge → NÃO mescla', async () => {
    // 1ª leitura: HEAD=SHA (checks verdes p/ SHA). Revalidação: HEAD virou SHA2.
    let call = 0
    const gw = gateway({
      getPullRequest: vi.fn(async () => {
        call += 1
        return {
          headSha: call === 1 ? SHA : SHA2,
          headRef: 'supremo/cp-x',
          nodeId: 'PR',
          merged: false,
          state: 'open',
        }
      }),
      getChecks: vi.fn(async () => ({ checks: green, headSha: SHA })),
    })
    const r = await reconcileMerge(gw, { prNumber: 7, requiredChecks: REQUIRED, mode: 'supremo_managed' })
    expect(gw.merge).not.toHaveBeenCalled()
    expect(r.decision).toBe('wait')
    expect(r.reasons.join(' ')).toMatch(/HEAD mudou/i)
    expect(r.headSha).toBe(SHA2)
  })

  it('checks de um SHA diferente do HEAD não liberam merge', async () => {
    const gw = gateway({ headSha: SHA, checksHeadSha: SHA2 }) // checks pertencem a outro SHA
    await reconcileMerge(gw, { prNumber: 7, requiredChecks: REQUIRED, mode: 'supremo_managed' })
    expect(gw.merge).not.toHaveBeenCalled()
  })

  it('PR já mesclada → noop idempotente', async () => {
    const gw = gateway({
      getPullRequest: vi.fn(async () => ({
        headSha: SHA,
        headRef: 'supremo/cp-x',
        nodeId: 'PR',
        merged: true,
        state: 'closed',
      })),
    })
    const r = await reconcileMerge(gw, { prNumber: 7, requiredChecks: REQUIRED, mode: 'supremo_managed' })
    expect(r.merged).toBe(true)
    expect(r.state).toBe('merged')
    expect(gw.merge).not.toHaveBeenCalled()
  })
})
