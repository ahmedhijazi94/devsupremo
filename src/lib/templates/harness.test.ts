import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { classifyRisk } from './verify-classifier'
import { harnessFiles, harnessPackageScripts, verifyScript, setupLocalScript } from './harness'

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
  it('emite os 4 arquivos do harness', () => {
    const files = harnessFiles()
    expect(Object.keys(files).sort()).toEqual([
      '.githooks/pre-commit',
      '.githooks/pre-push',
      'scripts/setup-local.mjs',
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
})
