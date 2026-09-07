import { describe, expect, it } from 'vitest'
import { DEVELOPMENT_POLICY_END, DEVELOPMENT_POLICY_START, withDevelopmentPolicy } from './development-policy'
import { computePlan } from './sync'

describe('upgrade of mixed user/platform instructions', () => {
  it('preserves legacy architecture and user preferences byte for byte', () => {
    const original = '# Meu app\r\n\r\nRLS obrigatório.\r\n\n## Preferências pessoais\nUse roxo; só teste quando eu pedir.\n'
    const updated = withDevelopmentPolicy(original)
    expect(updated.startsWith(original)).toBe(true)
    expect(updated).toContain('Instruções explícitas\ndo usuário continuam tendo precedência')
    expect(withDevelopmentPolicy(updated)).toBe(updated)
  })

  it('updates only the marked block, preserving custom instructions before and after it', () => {
    const prefix = '# Regras próprias\n'
    const suffix = '\n## Preferências\nValide quando solicitado.\n'
    const old = `${prefix}${DEVELOPMENT_POLICY_START}\npolítica anterior\n${DEVELOPMENT_POLICY_END}${suffix}`
    const updated = withDevelopmentPolicy(old)
    expect(updated.startsWith(prefix)).toBe(true)
    expect(updated.endsWith(suffix)).toBe(true)
    expect(updated).not.toContain('política anterior')
    expect(withDevelopmentPolicy(updated)).toBe(updated)
  })

  it('handles files without final newline without changing their content', () => {
    expect(withDevelopmentPolicy('# Regras próprias')).toMatch(/^# Regras próprias\n\n<!-- BEGIN/)
  })

  it.each([
    DEVELOPMENT_POLICY_START,
    DEVELOPMENT_POLICY_END,
    `${DEVELOPMENT_POLICY_END}\n${DEVELOPMENT_POLICY_START}`,
    `${DEVELOPMENT_POLICY_START}\n${DEVELOPMENT_POLICY_START}\n${DEVELOPMENT_POLICY_END}`,
  ])('refuses ambiguous markers instead of deleting user content', (source) => {
    expect(() => withDevelopmentPolicy(source)).toThrow(/política/)
  })

  it('plans policy upgrades while preserving app source and user additions', () => {
    const current = '# App personalizado\n\nNunca remova minhas instruções.\n'
    const files = [
      { path: 'AGENTS.md', content: 'new template' },
      { path: 'CLAUDE.md', content: 'new template' },
      { path: 'app/page.tsx', content: 'unrelated scaffold' },
    ]
    const existing = new Set(files.map(file => file.path))
    const plan = computePlan(files, existing, new Set(), new Map([['AGENTS.md', current], ['CLAUDE.md', withDevelopmentPolicy(current)]]))
    expect(plan.updates).toEqual([{ path: 'AGENTS.md', action: 'update', content: withDevelopmentPolicy(current) }])
    expect(plan.unchanged).toBe(1)
    expect(plan.skipped).toEqual(['app/page.tsx'])
  })
})
