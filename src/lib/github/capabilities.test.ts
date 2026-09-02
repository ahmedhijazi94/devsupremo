import { describe, expect, it } from 'vitest'
import {
  chooseMergeMode,
  protectionLevelFor,
  reevaluateMergeMode,
} from './capabilities'

describe('capability detection (native vs supremo_managed)', () => {
  it('escolhe NATIVE quando dá para proteger a main E usar auto-merge nativo', () => {
    expect(
      chooseMergeMode({ branchProtectionApplied: true, autoMergeAvailable: true }),
    ).toBe('native')
  })

  it('GitHub Free privado (sem proteção nativa) → SUPREMO_MANAGED', () => {
    expect(
      chooseMergeMode({ branchProtectionApplied: false, autoMergeAvailable: false }),
    ).toBe('supremo_managed')
  })

  it('não decide por nome de plano — capacidade parcial cai para managed (fail-safe)', () => {
    // plano diz "pro", mas a proteção não aplicou de fato → managed
    expect(
      chooseMergeMode({
        branchProtectionApplied: false,
        autoMergeAvailable: true,
        planHint: 'pro',
      }),
    ).toBe('supremo_managed')
    // auto-merge indisponível mesmo com proteção → managed
    expect(
      chooseMergeMode({ branchProtectionApplied: true, autoMergeAvailable: false }),
    ).toBe('supremo_managed')
  })

  it('ausência total de capacidade não quebra — devolve managed, nunca lança', () => {
    expect(() =>
      chooseMergeMode({ branchProtectionApplied: false, autoMergeAvailable: false }),
    ).not.toThrow()
  })

  it('protectionLevel é honesto sobre o modo (não mente na UI)', () => {
    expect(protectionLevelFor('native')).toBe('github_native')
    expect(protectionLevelFor('supremo_managed')).toBe('supremo_managed')
  })
})

describe('mudança de capacidade (upgrade/downgrade seguro)', () => {
  it('managed → native quando o repo passa a suportar (upgrade fortalece)', () => {
    const r = reevaluateMergeMode('supremo_managed', {
      branchProtectionApplied: true,
      autoMergeAvailable: true,
    })
    expect(r.mode).toBe('native')
    expect(r.changed).toBe(true)
    expect(r.direction).toBe('upgrade')
  })

  it('native → managed quando perde suporte (degrada sem deixar merge inseguro)', () => {
    const r = reevaluateMergeMode('native', {
      branchProtectionApplied: false,
      autoMergeAvailable: false,
    })
    expect(r.mode).toBe('supremo_managed')
    expect(r.direction).toBe('downgrade')
  })

  it('sem mudança quando a capacidade é a mesma', () => {
    const r = reevaluateMergeMode('native', {
      branchProtectionApplied: true,
      autoMergeAvailable: true,
    })
    expect(r.changed).toBe(false)
    expect(r.direction).toBe('same')
  })
})
