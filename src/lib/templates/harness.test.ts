import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { classifyRisk } from './verify-classifier'
import {
  decidePreviewAction,
  harnessFiles,
  harnessPackageScripts,
  previewSupervisorScript,
  supremoStatusScript,
  verifyScript,
  setupLocalScript,
} from './harness'

describe('preview supervisor (v3.1) — decisão pura', () => {
  it('vivo + saudável → reusa (uma instância só)', () => {
    expect(decidePreviewAction({ pidAlive: true, healthy: true })).toBe('reuse')
  })
  it('vivo mas não responde (zumbi) → reinicia', () => {
    expect(decidePreviewAction({ pidAlive: true, healthy: false })).toBe('restart')
  })
  it('nada rodando (morto/ausente) → inicia', () => {
    expect(decidePreviewAction({ pidAlive: false, healthy: false })).toBe('start')
    expect(decidePreviewAction({ pidAlive: false, healthy: true })).toBe('start')
  })
})

describe('preview supervisor (v3.1) — script gerado é determinístico', () => {
  const src = previewSupervisorScript()
  it('sobe DESACOPLADO (detached + unref) para sobreviver ao turno', () => {
    expect(src).toMatch(/detached:\s*true/)
    expect(src).toContain('.unref()')
  })
  it('mantém UMA instância via pidfile + health check', () => {
    expect(src).toContain('preview.pid')
    expect(src).toMatch(/http\.get/)
  })
  it('usa porta estável do projeto', () => {
    expect(src).toMatch(/process\.env\.PORT \|\| 3000/)
  })
  it('expõe ensure/status/stop', () => {
    for (const c of ['ensure', 'status', 'stop']) expect(src).toContain(c)
  })
  it('preview.mjs está no manifesto do harness', () => {
    expect(Object.keys(harnessFiles())).toContain('scripts/preview.mjs')
  })
  it('scripts npm preview:ensure/status/stop existem', () => {
    const s = harnessPackageScripts()
    expect(s['preview:ensure']).toBe('node scripts/preview.mjs ensure')
    expect(s['preview:status']).toBe('node scripts/preview.mjs status')
    expect(s['preview:stop']).toBe('node scripts/preview.mjs stop')
  })
})

describe('classifyRisk', () => {
  it('cosmético → quick', () => {
    expect(classifyRisk(['app/globals.css']).level).toBe('quick')
    expect(classifyRisk(['components/ui/button.tsx']).level).toBe('quick')
  })

  it('migration/sql → security', () => {
    expect(classifyRisk(['supabase/migrations/042_orders.sql']).level).toBe('security')
  })

  it('rota de API → security', () => {
    expect(classifyRisk(['app/api/orders/[id]/route.ts']).level).toBe('security')
  })

  it('server action → security', () => {
    expect(classifyRisk(['actions/orders.ts']).level).toBe('security')
  })

  it('arquivo de arquitetura/build → full', () => {
    expect(classifyRisk(['next.config.ts']).level).toBe('full')
    expect(classifyRisk(['package.json']).level).toBe('full')
    expect(classifyRisk(['tsconfig.json']).level).toBe('full')
  })

  it('mudança ampla → full', () => {
    const many = Array.from({ length: 30 }, (_, i) => `components/c${i}.tsx`)
    expect(classifyRisk(many).level).toBe('full')
  })

  it('mistura de cosmético + sensível → sobe pra security (conservador)', () => {
    expect(classifyRisk(['app/globals.css', 'actions/orders.ts']).level).toBe('security')
  })

  it('código comum (lib util) → quick', () => {
    expect(classifyRisk(['lib/format-date.ts']).level).toBe('quick')
  })

  it('nada alterado → quick vazio', () => {
    const r = classifyRisk([])
    expect(r.level).toBe('quick')
    expect(r.changed).toBe(0)
  })

  it('checks refletem as capabilities (security inclui tenant-isolation em multitenant)', () => {
    const r = classifyRisk(['supabase/migrations/1.sql'], ['auth', 'multitenant'])
    expect(r.checks).toEqual(expect.arrayContaining(['rls', 'tenant-isolation', 'idor']))
  })
})

describe('harness generator', () => {
  it('emite os 6 arquivos do harness (preview + status agregado)', () => {
    const files = harnessFiles()
    expect(Object.keys(files).sort()).toEqual([
      '.githooks/pre-commit',
      '.githooks/pre-push',
      'scripts/preview.mjs',
      'scripts/setup-local.mjs',
      'scripts/supremo-status.mjs',
      'scripts/verify.mjs',
    ])
  })

  it('package scripts expõem verify em três níveis + setup:local', () => {
    const s = harnessPackageScripts()
    expect(s.verify).toBeDefined()
    expect(s['verify:quick']).toBeDefined()
    expect(s['verify:security']).toBeDefined()
    expect(s['verify:full']).toBeDefined()
    expect(s['setup:local']).toBeDefined()
  })

  it('verify exclui os testes de RLS e os gateia por Supabase local', () => {
    const script = verifyScript()
    // unit/integration NÃO roda *.rls.test.ts (precisam de Postgres real)
    expect(script).toContain('vitest run --exclude "**/*.rls.test.ts"')
    // RLS só entra quando há service_role (Supabase local); senão, fica pro CI
    expect(script).toContain('SUPABASE_SERVICE_ROLE_KEY')
    expect(script).toContain("vitest run rls.test")
  })

  it('o verify.mjs gerado é JavaScript VÁLIDO (node --check)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'supremo-harness-'))
    const file = join(dir, 'verify.mjs')
    writeFileSync(file, verifyScript(), 'utf8')
    // node --check lança se houver erro de sintaxe.
    expect(() => execFileSync(process.execPath, ['--check', file])).not.toThrow()
  })

  it('o setup-local.mjs gerado é JavaScript VÁLIDO (node --check)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'supremo-harness-'))
    const file = join(dir, 'setup-local.mjs')
    writeFileSync(file, setupLocalScript(), 'utf8')
    expect(() => execFileSync(process.execPath, ['--check', file])).not.toThrow()
  })

  it('o supremo-status.mjs gerado é JavaScript VÁLIDO e agrega preview+daemon (seção 29)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'supremo-harness-'))
    const file = join(dir, 'supremo-status.mjs')
    const src = supremoStatusScript()
    writeFileSync(file, src, 'utf8')
    expect(() => execFileSync(process.execPath, ['--check', file])).not.toThrow()
    expect(src).toContain('scripts/preview.mjs')
    expect(src).toContain("'daemon', '--status'")
    expect(src).toContain('checkpoints')
  })

  it('package.json expõe supremo:status', () => {
    expect(harnessPackageScripts()['supremo:status']).toBe('node scripts/supremo-status.mjs')
  })
})
