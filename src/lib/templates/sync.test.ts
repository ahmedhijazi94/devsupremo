import { describe, it, expect } from 'vitest'
import {
  computePlan,
  planIsEmpty,
  planToFileChanges,
  gitBlobSha,
} from './sync'
import {
  buildProjectFiles,
  isManagedPath,
  MANAGED_PATHS,
} from './project-files'
import type { FileEntry } from './project-files'

describe('isManagedPath', () => {
  it('trata infra como rail', () => {
    expect(isManagedPath('lib/supabase/server.ts')).toBe(true)
    expect(isManagedPath('proxy.ts')).toBe(true)
    expect(isManagedPath('.github/workflows/ci.yml')).toBe(true)
    expect(isManagedPath('e2e/smoke.spec.ts')).toBe(true)
  })

  it('trata conteúdo do app como scaffold', () => {
    expect(isManagedPath('app/page.tsx')).toBe(false)
    expect(isManagedPath('supabase/migrations/00000000000000_initial_schema.sql')).toBe(false)
    expect(isManagedPath('package.json')).toBe(false)
    expect(isManagedPath('app/globals.css')).toBe(false)
  })

  it('nunca marca migration como rail — a garantia mais cara', () => {
    for (const path of MANAGED_PATHS) {
      expect(path.startsWith('supabase/migrations/')).toBe(false)
    }
  })
})

describe('gitBlobSha', () => {
  // Valores conhecidos do git (git hash-object).
  it('bate com o sha do git para conteúdo conhecido', () => {
    expect(gitBlobSha('')).toBe('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391')
    expect(gitBlobSha('hello\n')).toBe(
      'ce013625030ba8dba906f756967f9e9ca394464a',
    )
  })
})

describe('computePlan', () => {
  const files: FileEntry[] = [
    { path: 'proxy.ts', content: 'NOVO' }, // rail
    { path: 'lib/supabase/server.ts', content: 'NOVO' }, // rail
    { path: 'app/page.tsx', content: 'TEMPLATE' }, // scaffold
    { path: 'components/ui/badge.tsx', content: 'NOVO' }, // scaffold
  ]
  const allExist = new Set(files.map((f) => f.path))

  it('atualiza rail que divergiu, deixa rail idêntico em paz', () => {
    // server.ts em dia; proxy.ts divergiu.
    const upToDate = new Set(['lib/supabase/server.ts'])
    const plan = computePlan(files, allExist, upToDate)

    expect(plan.updates.map((u) => u.path)).toEqual(['proxy.ts'])
    expect(plan.unchanged).toBe(1)
  })

  it('NUNCA sobrescreve scaffold que já existe', () => {
    const plan = computePlan(files, allExist, new Set()) // rails divergiram
    const touched = [...plan.creates, ...plan.updates].map((i) => i.path)
    expect(touched).not.toContain('app/page.tsx')
    expect(touched).not.toContain('components/ui/badge.tsx')
    expect(plan.skipped).toContain('app/page.tsx')
    expect(plan.skipped).toContain('components/ui/badge.tsx')
  })

  it('cria arquivo que falta, seja rail ou scaffold', () => {
    const existing = new Set(['proxy.ts']) // só um existe
    const plan = computePlan(files, existing, new Set(['proxy.ts']))

    const created = plan.creates.map((c) => c.path)
    expect(created).toContain('lib/supabase/server.ts') // rail que faltava
    expect(created).toContain('app/page.tsx') // scaffold que faltava
    expect(created).toContain('components/ui/badge.tsx')
  })

  it('repo idêntico ao template não gera nada', () => {
    const upToDate = new Set(['proxy.ts', 'lib/supabase/server.ts'])
    const plan = computePlan(files, allExist, upToDate)
    expect(planIsEmpty(plan)).toBe(true)
  })
})

describe('planToFileChanges', () => {
  it('junta creates e updates em escritas', () => {
    const files: FileEntry[] = [
      { path: 'proxy.ts', content: 'A' },
      { path: 'vercel.json', content: 'B' },
    ]
    const existing = new Set(['proxy.ts']) // vercel.json falta
    const plan = computePlan(files, existing, new Set()) // proxy divergiu
    const changes = planToFileChanges(plan)

    expect(changes).toHaveLength(2)
    expect(changes.every((c) => typeof c.content === 'string')).toBe(true)
  })
})

describe('integração com o template real', () => {
  it('sobre um repo vazio, recria o template inteiro como creates', () => {
    const files = buildProjectFiles({
      projectName: 'demo',
      description: 'x',
      kind: 'solo',
    })
    const plan = computePlan(files, new Set(), new Set())
    expect(plan.creates).toHaveLength(files.length)
    expect(plan.updates).toHaveLength(0)
    expect(plan.skipped).toHaveLength(0)
  })

  it('sobre um repo idêntico ao template, não muda nada', () => {
    const files = buildProjectFiles({
      projectName: 'demo',
      description: 'x',
      kind: 'team',
    })
    const existing = new Set(files.map((f) => f.path))
    // Todo rail em dia.
    const upToDate = new Set(
      files.filter((f) => isManagedPath(f.path)).map((f) => f.path),
    )
    const plan = computePlan(files, existing, upToDate)
    expect(planIsEmpty(plan)).toBe(true)
  })

  it('um rail desatualizado num projeto real vira update, scaffold fica intacto', () => {
    const files = buildProjectFiles({
      projectName: 'demo',
      description: 'x',
      kind: 'solo',
    })
    const existing = new Set(files.map((f) => f.path))
    // Nenhum rail em dia; todo scaffold existe com trabalho do agente.
    const plan = computePlan(files, existing, new Set())

    const managedCount = files.filter((f) => isManagedPath(f.path)).length
    expect(plan.updates).toHaveLength(managedCount)
    const touched = [...plan.creates, ...plan.updates].map((i) => i.path)
    expect(touched.every((p) => isManagedPath(p))).toBe(true)
  })
})
