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
  pickFreePreviewPort,
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

/**
 * E2E real: porta 3000 já ocupada por OUTRO app fazia `preview:ensure`
 * considerar esse processo alheio como saudável e salvar um pid nosso que
 * logo morria/migrava de porta — falso positivo. `pickFreePreviewPort` é o
 * algoritmo (puro) que resolve isso: nunca sobe em cima de uma porta ocupada,
 * escolhe a próxima livre, e retorna `null` (nunca finge sucesso) se não
 * achar nenhuma no intervalo.
 */
describe('preview supervisor (v3.1) — pickFreePreviewPort (colisão de porta)', () => {
  it('porta preferida livre → usa ela mesma (comportamento inalterado no caso comum)', () => {
    expect(pickFreePreviewPort(3000, () => true)).toBe(3000)
  })
  it('porta preferida OCUPADA (por outro app/projeto) → escolhe a próxima livre, nunca reusa a ocupada', () => {
    const busy = new Set([3000, 3001])
    expect(pickFreePreviewPort(3000, (p) => !busy.has(p))).toBe(3002)
  })
  it('várias portas seguidas ocupadas → segue procurando até achar uma livre', () => {
    const busy = new Set([3000, 3001, 3002, 3003, 3004])
    expect(pickFreePreviewPort(3000, (p) => !busy.has(p))).toBe(3005)
  })
  it('TODAS as portas do intervalo ocupadas → null (falha clara, NUNCA falso positivo)', () => {
    expect(pickFreePreviewPort(3000, () => false, 5)).toBeNull()
  })
  it('span customizado é respeitado (não procura além dele)', () => {
    // livre só na 3010, mas span=5 só cobre 3000-3004 → não acha, retorna null.
    expect(pickFreePreviewPort(3000, (p) => p === 3010, 5)).toBeNull()
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
  it('NUNCA sobe em cima de uma porta sem antes confirmar (bind-probe via node:net) que está livre', () => {
    // O bug real era health-check HTTP sendo tratado como prova de posse. O
    // fix exige um bind-probe (net.createServer) ANTES de startDetached —
    // garante que o script gerado não regride pra "assume que respondeu = é
    // meu".
    expect(src).toContain("import net from 'node:net'")
    expect(src).toContain('net.createServer()')
    expect(src).toContain('function isPortFree(port)')
    // startDetached (quem efetivamente sobe o processo) só é chamado depois
    // de pickPort resolver uma porta confirmada livre — nunca com a porta
    // configurada às cegas.
    expect(src).toMatch(/const chosen = await pickPort\(PORT\)/)
    expect(src).toMatch(/startDetached\(chosen\)/)
  })
  it('persiste a porta REAL em uso (pode diferir da preferida) — status/ensure seguintes checam essa, não a configurada às cegas', () => {
    expect(src).toContain('preview.port')
    expect(src).toContain('function readPort()')
    expect(src).toMatch(/writeFileSync\(PORTFILE, String\(port\)\)/)
  })
  it('sem porta livre no intervalo → falha CLARO (stderr + exit code != 0), nunca finge sucesso', () => {
    expect(src).toMatch(/if \(chosen === null\)/)
    expect(src).toContain('console.error(')
    expect(src).toMatch(/process\.exitCode = 1/)
  })
  it('o bind-probe checa IPv4 E IPv6 (loopback + wildcard das duas) — não só IPv4 (bug real: foreign server só no wildcard IPv6 "::" passava batido)', () => {
    expect(src).toMatch(/PROBE_HOSTS\s*=\s*\[HOST,\s*'0\.0\.0\.0',\s*'::',\s*'::1'\]/)
    // só EADDRINUSE prova ocupação — qualquer outro erro (ex.: IPv6
    // indisponível na máquina) não pode derrubar a varredura inteira.
    expect(src).toContain("err.code === 'EADDRINUSE'")
  })
  it('o script gerado é JavaScript VÁLIDO (node --check)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'supremo-harness-preview-'))
    const file = join(dir, 'preview.mjs')
    writeFileSync(file, src, 'utf8')
    expect(() => execFileSync(process.execPath, ['--check', file])).not.toThrow()
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
