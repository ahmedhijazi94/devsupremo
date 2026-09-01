import { describe, expect, it } from 'vitest'
import {
  capabilitiesForKind,
  collectEnvVars,
  inferSecurityProfile,
  resolveCapabilities,
  securityChecksFor,
  securityInvariantsFor,
  IMPLEMENTED_CAPABILITY_IDS,
} from './index'

describe('resolveCapabilities', () => {
  it('expande dependências (multitenant → auth)', () => {
    expect(resolveCapabilities(['multitenant'])).toEqual(['auth', 'multitenant'])
  })

  it('deduplica e mantém ordem canônica', () => {
    expect(resolveCapabilities(['storage', 'auth', 'auth'])).toEqual([
      'auth',
      'storage',
    ])
  })

  it('rejeita capability só planejada (não implementada)', () => {
    expect(() => resolveCapabilities(['rag'])).toThrow(/não é implementada/)
  })

  it('rejeita capability desconhecida', () => {
    // @ts-expect-error — id inválido de propósito
    expect(() => resolveCapabilities(['telepatia'])).toThrow(/desconhecida/)
  })

  it('CORE puro é lista vazia', () => {
    expect(resolveCapabilities([])).toEqual([])
  })
})

describe('inferSecurityProfile', () => {
  it('sem capabilities → simple', () => {
    expect(inferSecurityProfile([])).toBe('simple')
  })

  it('auth → standard', () => {
    expect(inferSecurityProfile(['auth'])).toBe('standard')
  })

  it('multitenant → multitenant', () => {
    expect(inferSecurityProfile(['auth', 'multitenant'])).toBe('multitenant')
  })

  it('superfície privilegiada → sensitive', () => {
    expect(inferSecurityProfile(['auth', 'admin'])).toBe('sensitive')
  })

  it('kind é só PISO, nunca abaixa o detectado pelas capabilities', () => {
    // kind solo (piso=standard) não rebaixa um multitenant real
    expect(
      inferSecurityProfile(['auth', 'multitenant'], { kind: 'solo' }),
    ).toBe('multitenant')
  })

  it('kind eleva quando as capabilities não capturaram (piso)', () => {
    expect(inferSecurityProfile([], { kind: 'team' })).toBe('multitenant')
    expect(inferSecurityProfile([], { kind: 'solo' })).toBe('standard')
    expect(inferSecurityProfile([], { kind: 'public' })).toBe('simple')
  })
})

describe('securityChecksFor', () => {
  it('CORE liga baseline sempre (secrets, xss, migration-safety)', () => {
    const checks = securityChecksFor([])
    expect(checks).toContain('secrets')
    expect(checks).toContain('xss')
    expect(checks).toContain('migration-safety')
  })

  it('auth liga rls + authorization', () => {
    const checks = securityChecksFor(['auth'])
    expect(checks).toEqual(
      expect.arrayContaining(['rls', 'authorization', 'secrets', 'xss']),
    )
  })

  it('multitenant liga tenant-isolation + idor', () => {
    const checks = securityChecksFor(['auth', 'multitenant'])
    expect(checks).toEqual(
      expect.arrayContaining(['tenant-isolation', 'idor']),
    )
  })
})

describe('collectEnvVars', () => {
  it('auth declara as env públicas do Supabase (deduplicadas)', () => {
    const vars = collectEnvVars(['auth'])
    const names = vars.map((v) => v.name)
    expect(names).toContain('NEXT_PUBLIC_SUPABASE_URL')
    expect(names).toContain('NEXT_PUBLIC_SUPABASE_ANON_KEY')
    // todas públicas e auto-provisionadas
    expect(vars.every((v) => v.public && v.autoProvisioned)).toBe(true)
  })

  it('capability desligada não deixa rastro (CORE puro sem env extra)', () => {
    expect(collectEnvVars([])).toEqual([])
    expect(securityInvariantsFor([])).toEqual([])
  })
})

describe('capabilitiesForKind (ponte legada)', () => {
  it('public → só CORE', () => {
    expect(capabilitiesForKind('public')).toEqual([])
  })
  it('solo → auth', () => {
    expect(capabilitiesForKind('solo')).toEqual(['auth'])
  })
  it('team → auth + multitenant', () => {
    expect(capabilitiesForKind('team')).toEqual(['auth', 'multitenant'])
  })
})

describe('registry', () => {
  it('expõe só capabilities implementadas para a UI', () => {
    expect(IMPLEMENTED_CAPABILITY_IDS).toEqual(['auth', 'multitenant', 'storage'])
  })
})
