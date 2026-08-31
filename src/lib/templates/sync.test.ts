import { describe, it, expect } from 'vitest'
import { computePlan, planIsEmpty, planToFileChanges } from './sync'
import {
  buildProjectFiles,
  isManagedPath,
  MANAGED_PATHS,
} from './project-files'
import type { FileEntry } from './project-files'

/** Um repo hipotético: todo caminho existe, com o conteúdo dado. */
function repoFrom(entries: Record<string, string>) {
  return {
    existing: new Set(Object.keys(entries)),
    content: new Map(Object.entries(entries)),
  }
}

describe('isManagedPath', () => {
  it('trata infra como rail', () => {
    expect(isManagedPath('lib/supabase/server.ts')).toBe(true)
    expect(isManagedPath('proxy.ts')).toBe(true)
    expect(isManagedPath('.github/workflows/ci.yml')).toBe(true)
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

describe('computePlan', () => {
  const files: FileEntry[] = [
    { path: 'proxy.ts', content: 'NOVO' }, // rail
    { path: 'lib/supabase/server.ts', content: 'NOVO' }, // rail
    { path: 'app/page.tsx', content: 'TEMPLATE' }, // scaffold
    { path: 'components/ui/badge.tsx', content: 'NOVO' }, // scaffold
  ]

  it('atualiza rail que divergiu, deixa rail idêntico em paz', () => {
    const repo = repoFrom({
      'proxy.ts': 'ANTIGO', // divergiu → update
      'lib/supabase/server.ts': 'NOVO', // igual → unchanged
      'app/page.tsx': 'TRABALHO DO AGENTE',
      'components/ui/badge.tsx': 'existe',
    })
    const plan = computePlan(files, repo.existing, repo.content)

    expect(plan.updates.map((u) => u.path)).toEqual(['proxy.ts'])
    expect(plan.unchanged).toBe(1)
  })

  it('NUNCA sobrescreve scaffold que já existe', () => {
    const repo = repoFrom({
      'proxy.ts': 'NOVO',
      'lib/supabase/server.ts': 'NOVO',
      'app/page.tsx': 'HOME QUE O AGENTE CONSTRUIU',
      'components/ui/badge.tsx': 'BOTÃO CUSTOMIZADO',
    })
    const plan = computePlan(files, repo.existing, repo.content)

    // Nenhum scaffold nas escritas.
    const touched = [...plan.creates, ...plan.updates].map((i) => i.path)
    expect(touched).not.toContain('app/page.tsx')
    expect(touched).not.toContain('components/ui/badge.tsx')
    expect(plan.skipped).toContain('app/page.tsx')
    expect(plan.skipped).toContain('components/ui/badge.tsx')
  })

  it('cria arquivo que falta, seja rail ou scaffold', () => {
    const repo = repoFrom({ 'proxy.ts': 'NOVO' }) // só um existe
    const plan = computePlan(files, repo.existing, repo.content)

    const created = plan.creates.map((c) => c.path)
    expect(created).toContain('lib/supabase/server.ts') // rail que faltava
    expect(created).toContain('app/page.tsx') // scaffold que faltava
    expect(created).toContain('components/ui/badge.tsx')
  })

  it('repo idêntico ao template não gera nada', () => {
    const repo = repoFrom({
      'proxy.ts': 'NOVO',
      'lib/supabase/server.ts': 'NOVO',
      'app/page.tsx': 'qualquer coisa', // scaffold existente é ignorado
      'components/ui/badge.tsx': 'qualquer coisa',
    })
    const plan = computePlan(files, repo.existing, repo.content)
    expect(planIsEmpty(plan)).toBe(true)
  })
})

describe('planToFileChanges', () => {
  it('junta creates e updates em escritas', () => {
    const files: FileEntry[] = [
      { path: 'proxy.ts', content: 'A' },
      { path: 'vercel.json', content: 'B' },
    ]
    const repo = repoFrom({ 'proxy.ts': 'velho' }) // vercel.json falta
    const plan = computePlan(files, repo.existing, repo.content)
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
    const plan = computePlan(files, new Set(), new Map())
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
    const content = new Map(files.map((f) => [f.path, f.content]))
    const plan = computePlan(files, existing, content)
    expect(planIsEmpty(plan)).toBe(true)
  })

  it('um rail desatualizado num projeto real vira update, scaffold fica intacto', () => {
    const files = buildProjectFiles({
      projectName: 'demo',
      description: 'x',
      kind: 'solo',
    })
    const existing = new Set(files.map((f) => f.path))
    // Todo rail existe com conteúdo velho; todo scaffold existe com trabalho.
    const content = new Map(
      files
        .filter((f) => isManagedPath(f.path))
        .map((f) => [f.path, '// versão antiga']),
    )
    const plan = computePlan(files, existing, content)

    // Todos os rails viram update; nenhum scaffold é tocado.
    const managedCount = files.filter((f) => isManagedPath(f.path)).length
    expect(plan.updates).toHaveLength(managedCount)
    const touched = [...plan.creates, ...plan.updates].map((i) => i.path)
    expect(touched.every((p) => isManagedPath(p))).toBe(true)
  })
})
