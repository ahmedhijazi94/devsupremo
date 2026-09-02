import { describe, expect, it } from 'vitest'
import {
  assertNotMain,
  baseIsFresh,
  planIntegration,
  rotatedBranchName,
  type RemotePr,
} from './integration'

const pr = (over: Partial<RemotePr> = {}): RemotePr => ({
  number: 7,
  headRef: 'supremo/cp-aaaaaaaaaaaa',
  headSha: 'sha-A',
  merged: false,
  state: 'open',
  ...over,
})

describe('assertNotMain — nada vai direto à main (teste 18)', () => {
  it('recusa main/master', () => {
    expect(() => assertNotMain('main')).toThrow()
    expect(() => assertNotMain('master')).toThrow()
  })
  it('aceita branch de trabalho', () => {
    expect(() => assertNotMain('supremo/cp-123')).not.toThrow()
  })
  it('rotatedBranchName nunca é main', () => {
    const b = rotatedBranchName('deadbeefcafebabe0000')
    expect(b).toBe('supremo/cp-deadbeefcafe')
    expect(() => assertNotMain(b)).not.toThrow()
  })
})

describe('planIntegration — reuse vs rotate', () => {
  it('PR aberta e não mergeada na nossa branch → REUSE (ff), nunca main', () => {
    const plan = planIntegration({
      remote: {
        mainSha: 'main-1',
        openPr: pr({ headRef: 'supremo/cp-aaaaaaaaaaaa' }),
        integrationBranch: 'supremo/cp-aaaaaaaaaaaa',
      },
      local: { headSha: 'sha-B', lastIntegratedSha: 'sha-A' },
    })
    expect(plan.action).toBe('reuse')
    expect(plan.branch).toBe('supremo/cp-aaaaaaaaaaaa')
    expect(plan.branch).not.toBe('main')
    if (plan.action === 'reuse') {
      expect(plan.pushSha).toBe('sha-B')
      expect(plan.expectedBaseSha).toBe('main-1')
    }
  })

  it('PR anterior JÁ MERGEADA → ROTATE com delta = B, sem perder B (teste 16)', () => {
    const plan = planIntegration({
      remote: {
        mainSha: 'main-2', // A já entrou na main
        openPr: pr({ merged: true, state: 'closed' }),
        integrationBranch: 'supremo/cp-aaaaaaaaaaaa',
      },
      local: { headSha: 'sha-B', lastIntegratedSha: 'sha-A' },
    })
    expect(plan.action).toBe('rotate')
    expect(plan.branch).not.toBe('main')
    if (plan.action === 'rotate') {
      // integra só o delta ainda não integrado (A..B), sobre a main atual
      expect(plan.deltaRange).toEqual({ fromSha: 'sha-A', toSha: 'sha-B' })
      expect(plan.expectedBaseSha).toBe('main-2')
      expect(plan.base).toBe('main')
    }
  })

  it('sem PR aberta → ROTATE nova branch sobre a main atual', () => {
    const plan = planIntegration({
      remote: { mainSha: 'main-1', openPr: null, integrationBranch: null },
      local: { headSha: 'sha-A', lastIntegratedSha: null },
    })
    expect(plan.action).toBe('rotate')
    expect(plan.branch).toBe(rotatedBranchName('sha-A'))
  })

  it('branch da PR divergiu da nossa → ROTATE (não reusa branch alheia)', () => {
    const plan = planIntegration({
      remote: {
        mainSha: 'main-1',
        openPr: pr({ headRef: 'outra-branch' }),
        integrationBranch: 'supremo/cp-aaaaaaaaaaaa',
      },
      local: { headSha: 'sha-B', lastIntegratedSha: 'sha-A' },
    })
    expect(plan.action).toBe('rotate')
  })
})

describe('baseIsFresh — HEAD antigo não integra (teste 17)', () => {
  it('main igual à esperada → fresco', () => {
    expect(baseIsFresh('main-1', 'main-1')).toBe(true)
  })
  it('main avançou depois do plano → stale (não integra)', () => {
    expect(baseIsFresh('main-2', 'main-1')).toBe(false)
  })
})
