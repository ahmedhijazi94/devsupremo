import { describe, expect, it } from 'vitest'
import { validateAutomaticMigration } from '../database-environment/policy'
import { DEVELOPMENT_POLICY_END, DEVELOPMENT_POLICY_START } from './development-policy'
import { buildProjectFiles } from './project-files'
import { computePlan } from './sync'

describe('shared development guidance in generated projects', () => {
  it.each(['public', 'solo', 'team'] as const)('keeps the operational contract when adapting %s from Next to Start', kind => {
    const generate = (stack: 'nextjs' | 'tanstack-start-vite') => new Map(buildProjectFiles({ projectName: 'workflow', description: '', kind, stack }).map(file => [file.path, file.content]))
    const next = generate('nextjs')
    const start = generate('tanstack-start-vite')
    const block = (content: string) => content.slice(content.indexOf(DEVELOPMENT_POLICY_START), content.indexOf(DEVELOPMENT_POLICY_END))
    for (const name of ['AGENTS.md', 'CLAUDE.md', '.supremo/DEVELOPMENT.md']) {
      expect(block(start.get(name)!)).toBe(block(next.get(name)!))
      expect(block(start.get(name)!)).toContain('Não espere terminar a escrita dos testes')
      expect(block(start.get(name)!)).toContain('Continue o restante do pedido e as provas neste mesmo turno')
      expect(block(start.get(name)!)).toContain('recovery-check de falhas anteriores confirmadas')
      expect(block(start.get(name)!)).toContain('seção Migrations no desenvolvimento')
      expect(block(start.get(name)!)).not.toContain('preflight e os gates normais antes')
    }
    const guide = (content: string) => content.slice(content.indexOf('## Migrations no desenvolvimento'), content.indexOf('## Chaves de integrações'))
    expect(guide(start.get('.supremo/DEVELOPMENT.md')!)).toBe(guide(next.get('.supremo/DEVELOPMENT.md')!))
    // Policy changes must not silently alter migrations or validation requirements.
    for (const [name, content] of next) {
      if (name.startsWith('supabase/')) expect(start.get(name)).toBe(content)
    }
  })

  it('ships SQL that the real automatic-migration guard accepts, while privilege and syntax changes stay denied', () => {
    const guide = buildProjectFiles({ projectName: 'guide', description: '', stack: 'tanstack-start-vite' }).find(file => file.path === '.supremo/DEVELOPMENT.md')!.content
    const examples = [...guide.matchAll(/```sql\n([\s\S]*?)```/g)].map(match => match[1]!)
    expect(examples).toHaveLength(1)
    for (const sql of examples) {
      expect(() => validateAutomaticMigration(sql)).not.toThrow()
      expect(() => validateAutomaticMigration(sql.replace('SECURITY INVOKER', 'SECURITY DEFINER'))).toThrow(/qualquer schema/)
      expect(() => validateAutomaticMigration(sql.replaceAll('private.', 'expense_private.'))).toThrow(/fora do formato/)
      expect(() => validateAutomaticMigration(sql.replace('RETURN NEW;', "EXECUTE 'SELECT 1'; RETURN NEW;"))).toThrow()
    }
  })

  it('upgrades only the owned guides and instruction block, preserving app code and user directions', () => {
    const files = buildProjectFiles({ projectName: 'update', description: '', stack: 'tanstack-start-vite' })
      .filter(file => ['AGENTS.md', '.supremo/DEVELOPMENT.md', 'src/routes/index.tsx'].includes(file.path))
    const custom = `# Meu projeto\nMantenha a cor azul.\n${DEVELOPMENT_POLICY_START}\nold workflow\n${DEVELOPMENT_POLICY_END}\nNão altere meus textos.\n`
    const existing = new Set(files.map(file => file.path))
    const plan = computePlan(files, existing, new Set(), new Map([['AGENTS.md', custom]]))
    expect(plan.creates).toEqual([])
    expect(plan.updates.map(file => file.path)).toEqual(['AGENTS.md', '.supremo/DEVELOPMENT.md'])
    expect(plan.skipped).toEqual(['src/routes/index.tsx'])
    expect(plan.updates[0]!.content).toMatch(/^# Meu projeto\nMantenha a cor azul\./)
    expect(plan.updates[0]!.content).toMatch(/Não altere meus textos\.\n$/)
    const second = computePlan(files, existing, new Set(['.supremo/DEVELOPMENT.md']), new Map([['AGENTS.md', plan.updates[0]!.content]]))
    expect(second.creates).toEqual([])
    expect(second.updates).toEqual([])
  })
})
