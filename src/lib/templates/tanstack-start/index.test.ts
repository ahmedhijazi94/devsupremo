import { describe, expect, it } from 'vitest'
import { buildProjectFiles, type FileEntry } from '../project-files'
import { adaptTanStackFiles } from './index'

const byPath = (files: FileEntry[]) => new Map(files.map((file) => [file.path, file.content]))

describe('TanStack template boundary', () => {
  it.each(['public', 'solo', 'team'] as const)('preserves migrations and isolation proofs for %s', (kind) => {
    const legacy = buildProjectFiles({ projectName: 'proof', description: '', kind, stack: 'nextjs' })
    const next = byPath(legacy)
    const start = byPath(buildProjectFiles({ projectName: 'proof', description: '', kind, stack: 'tanstack-start-vite' }))
    for (const [name, content] of next) {
      if (name.startsWith('supabase/') || name.endsWith('.rls.test.ts') || name === 'e2e/smoke.spec.ts') expect(start.get(name), name).toBe(content)
    }
    expect(start.get('.github/workflows/ci.yml')).toBe(next.get('.github/workflows/ci.yml')?.replaceAll('NEXT_PUBLIC_SUPABASE_URL', 'VITE_SUPABASE_URL').replaceAll('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'VITE_SUPABASE_ANON_KEY'))
    expect(start.has('src/routes/login.tsx')).toBe(kind !== 'public')
    expect(start.has('src/features/organizations/organization.server.ts')).toBe(kind === 'team')
    expect(start.has('app/page.tsx')).toBe(false)
    expect(start.has('next.config.ts')).toBe(false)
    expect(start.get('src/routes/index.tsx')).not.toContain('__AUTH_HOME_LINK__')
  })
  it('pins direct dependencies with a matching deterministic lockfile and distinct stack metadata', () => {
    const options = { projectName: 'proof', description: '', kind: 'solo', stack: 'tanstack-start-vite' } as const
    const first = buildProjectFiles(options)
    expect(buildProjectFiles(options)).toEqual(first)
    const files = byPath(first)
    const pkg = JSON.parse(files.get('package.json')!) as { name: string; dependencies: Record<string, string>; devDependencies: Record<string, string> }
    const lock = JSON.parse(files.get('package-lock.json')!) as { packages: Record<string, { dependencies: Record<string, string>; devDependencies: Record<string, string> }> }
    expect(pkg.dependencies).toEqual(lock.packages['']!.dependencies)
    expect(pkg.devDependencies).toEqual(lock.packages['']!.devDependencies)
    for (const version of Object.values({ ...pkg.dependencies, ...pkg.devDependencies })) expect(version).toMatch(/^(?:\d+\.\d+\.\d+(?:-[\w.-]+)?|file:tools\/supremo-cli)$/)
    expect(pkg.dependencies).not.toHaveProperty('next')
    expect(JSON.parse(files.get('.supremo/project.json')!)).toMatchObject({ stack: 'tanstack-start-vite', scaffoldVersion: '5.1.1' })
    expect(files.get('vite.config.mts')).toContain('envPrefix: []')
    expect(files.get('vite.config.mts')).toContain("behavior: 'error'")
    expect(files.get('src/start.ts')).toContain('createCsrfMiddleware')
    expect(files.get('src/routes/__root.tsx')).toContain('(import.meta.env.DEV || import.meta.env.SUPREMO_HOSTED_PREVIEW) && <PreviewInspector />')
  })
  it('escapes project content in both JSX and string literals without executing markup', () => {
    const files = byPath(buildProjectFiles({ projectName: "<Demo>{'x'}", description: '<script>alert(1)</script>', stack: 'tanstack-start-vite' }))
    expect(files.get('src/routes/index.tsx')).toContain('&lt;Demo&gt;&#123;')
    expect(files.get('src/routes/index.tsx')).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(files.get('src/routes/__root.tsx')).toContain("\\'x\\'")
  })
  it.each(['public', 'solo', 'team'] as const)('delivers first-request preparation without installed dependencies for %s', kind => {
    const files = byPath(buildProjectFiles({ projectName: 'onboarding', description: '', kind, stack: 'tanstack-start-vite' }))
    const pkg = JSON.parse(files.get('package.json')!) as { scripts: Record<string, string> }
    expect(pkg.scripts).not.toHaveProperty('prepare')
    expect(pkg.scripts['supremo:prepare']).toBe('node tools/supremo-cli/dist/bin.js prepare')
    expect(pkg.scripts['preview:ensure']).toBe('node tools/supremo-cli/dist/bin.js runtime-preview ensure')
    expect(files.has('tools/supremo-cli/dist/bin.js')).toBe(true)
    for (const name of ['AGENTS.md', 'CLAUDE.md', '.supremo/DEVELOPMENT.md']) {
      expect(files.get(name)).toContain('Primeiro pedido de desenvolvimento')
      expect(files.get(name)).toContain('Aguarde a resposta antes da preparação e das edições')
      expect(files.get(name)).toContain('Pedidos somente de leitura continuam somente de leitura')
    }
    for (const entry of ['.supremo/runtime/', '.supremo/onboarding.json', '.supremo/prepare-readiness.json']) expect(files.get('.gitignore')).toContain(entry)
  })
  it('uses the configured Supremo origin for hosted preview without client-controlled origin grants', () => {
    const legacy = buildProjectFiles({ projectName: 'proof', description: '' })
    const metadata = legacy.find((file) => file.path === '.supremo/project.json')!
    metadata.content = JSON.stringify({ supremoUrl: 'https://supremo.example/platform' })
    expect(byPath(adaptTanStackFiles(legacy, { projectName: 'proof', description: '' })).get('src/start.ts')).toContain("supremoOrigin: 'https://supremo.example'")
  })
})
