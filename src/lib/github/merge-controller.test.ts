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
    hasRequiredChecks: vi.fn(async () => true),
    allowAutoMerge: vi.fn(async () => true),
    enableNativeAutoMerge: vi.fn(async () => true),
    merge: vi.fn(async () => ({ sha: head })),
    deleteBranch: vi.fn(async () => {}),
    ...over,
  }
}

describe('reconcileMerge — modo NATIVE_GITHUB', () => {
  it('habilita o auto-merge nativo e NÃO mescla ele mesmo', async () => {
    const gw = gateway()
    const r = await reconcileMerge(gw, { prNumber: 1, requiredChecks: REQUIRED, mode: 'native' })
    expect(gw.enableNativeAutoMerge).toHaveBeenCalledWith('PR_node')
    expect(gw.allowAutoMerge).toHaveBeenCalled()
    expect(gw.merge).not.toHaveBeenCalled() // quem mescla é o GitHub
    expect(r.state).toBe('merge_pending')
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
