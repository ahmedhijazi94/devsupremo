import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { classifyRisk, isKnownEnvironmentalBuildFailure } from './verify-classifier'
import {
  classifyBindProbe,
  classifyPidSignalError,
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

/**
 * E2E real: `preview:ensure` rodando dentro do sandbox do Codex. Um preview
 * saudável sobreviveu entre "prompts" (pid antigo, :3001), mas o prompt
 * seguinte rodou em outro contexto de sandbox onde `process.kill(pid, 0)`
 * no pid antigo deu EPERM (não ESRCH) — o processo seguia vivo e saudável,
 * só não sinalizável DAQUELE contexto. O supervisor tratava EPERM como
 * "morto" e sobrescrevia .supremo/preview.pid/.port pro pid/porta de uma
 * candidata nova (que morreu com `listen EPERM`) ANTES de confirmar que ela
 * respondia — perdendo o rastro da instância antiga, que seguia rodando.
 */
describe('preview supervisor (v3.1) — classifyPidSignalError (ESRCH vs EPERM/desconhecido)', () => {
  it('ESRCH → dead (processo comprovadamente não existe mais)', () => {
    expect(classifyPidSignalError('ESRCH')).toBe('dead')
  })
  it('EPERM → unknown (existe, só não dá pra sinalizar — NUNCA "dead")', () => {
    expect(classifyPidSignalError('EPERM')).toBe('unknown')
  })
  it('qualquer outro código, ou nenhum → unknown (nunca assume morto sem ESRCH)', () => {
    expect(classifyPidSignalError('EACCES')).toBe('unknown')
    expect(classifyPidSignalError(undefined)).toBe('unknown')
    expect(classifyPidSignalError(null)).toBe('unknown')
  })
})

describe('preview supervisor (v3.1) — classifyBindProbe (erro indeterminado nunca prova porta livre)', () => {
  it('sem erro (bind teve sucesso) → free', () => {
    expect(classifyBindProbe(null)).toBe('free')
    expect(classifyBindProbe(undefined)).toBe('free')
  })
  it('EADDRINUSE → busy (única prova real de ocupação)', () => {
    expect(classifyBindProbe('EADDRINUSE')).toBe('busy')
  })
  it('família de endereço indisponível NESTA máquina (ex.: IPv6 desligado) → skip, não conta como ocupado', () => {
    expect(classifyBindProbe('EADDRNOTAVAIL')).toBe('skip')
    expect(classifyBindProbe('EAFNOSUPPORT')).toBe('skip')
  })
  it('erro INDETERMINADO (ex.: EPERM de bind restrito por sandbox) → busy, NUNCA free — bug real do E2E era o oposto', () => {
    expect(classifyBindProbe('EPERM')).toBe('busy')
    expect(classifyBindProbe('EACCES')).toBe('busy')
    expect(classifyBindProbe('ALGUM_CODIGO_NUNCA_VISTO')).toBe('busy')
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
    expect(src).toMatch(/writeFileSync\(PORTFILE, String\(chosen\)\)/)
  })
  it('sem porta livre no intervalo → falha CLARO (stderr + exit code != 0), nunca finge sucesso', () => {
    expect(src).toMatch(/if \(chosen === null\)/)
    expect(src).toContain('console.error(')
    expect(src).toMatch(/process\.exitCode = 1/)
  })
  it('o bind-probe checa IPv4 E IPv6 (loopback + wildcard das duas) — não só IPv4 (bug real: foreign server só no wildcard IPv6 "::" passava batido)', () => {
    expect(src).toMatch(/PROBE_HOSTS\s*=\s*\[HOST,\s*'0\.0\.0\.0',\s*'::',\s*'::1'\]/)
    // só EADDRINUSE prova ocupação real.
    expect(src).toContain("code === 'EADDRINUSE'")
  })
  it('erro de bind INDETERMINADO (ex.: EPERM de um sandbox) NUNCA vira prova de porta livre — tratado como ocupado, nunca "skip" nem "free"', () => {
    // Bug real do E2E: um sandbox restringindo o bind fazia a porta PARECER
    // livre (qualquer erro != EADDRINUSE virava "não ocupado"). Fix: só
    // códigos que provam "família de endereço indisponível NESTA máquina"
    // (IPv6 desligado, por exemplo) são ignorados sem contar como ocupado —
    // qualquer OUTRO erro (EPERM incluso) conta como ocupado (conservador).
    expect(src).toContain('function classifyBindError(code)')
    expect(src).toMatch(/ADDRESS_FAMILY_UNAVAILABLE = \[.*EADDRNOTAVAIL.*EAFNOSUPPORT.*\]/)
    expect(src).toMatch(/return 'skip'/)
    // o fallback final (nem EADDRINUSE nem família indisponível) é 'busy'.
    expect(src.match(/function classifyBindError\(code\) \{[\s\S]*?\n\}/)?.[0]).toMatch(
      /return 'busy'\s*\n\}$/,
    )
  })
  it('alive()/status()/ensure() usam pidState (ESRCH vs EPERM/desconhecido) — nunca kill(pid,0) cru tratando qualquer erro como morto', () => {
    expect(src).toContain('function pidState(pid)')
    expect(src).toMatch(/return \(err && err\.code\) === 'ESRCH' \? 'dead' : 'unknown'/)
    expect(src).toMatch(/function alive\(pid\) \{\s*\n\s*return pidState\(pid\) !== 'dead'/)
  })
  it('ensure() checa a saúde da porta rastreada SEMPRE (não só quando alive(pid) é true) — nunca perde uma instância saudável por EPERM', () => {
    // O bug real: a checagem de saúde ficava DENTRO de `if (alive(pid))`, e
    // alive() tratava EPERM como falso — então uma instância saudável mas
    // não-sinalizável (sandbox) nunca era detectada. Fix: health(trackedPort)
    // é chamado incondicionalmente, direto no decide().
    expect(src).toMatch(/const action = decide\(alive\(pid\), await health\(trackedPort\)\)/)
  })
  it('candidata nova que NÃO fica saudável NUNCA sobrescreve .supremo/preview.pid|.port — estado anterior é preservado', () => {
    // startDetached não grava mais os arquivos de estado — só ensure() grava,
    // e só DEPOIS de waitReady confirmar sucesso.
    const startDetachedBody = src.slice(
      src.indexOf('function startDetached(port)'),
      src.indexOf('async function ensure()'),
    )
    expect(startDetachedBody).not.toContain('writeFileSync(PIDFILE')
    expect(startDetachedBody).not.toContain('writeFileSync(PORTFILE')
    expect(src).toMatch(/if \(!ok\) \{/)
    expect(src).toMatch(/mantendo estado anterior/)
    // as ÚNICAS gravações de PIDFILE/PORTFILE em ensure() ficam depois do
    // `if (!ok) { ... return }` — nunca antes de confirmar a candidata.
    const ensureBody = src.slice(src.indexOf('async function ensure()'), src.indexOf('async function status()'))
    const okCheckIdx = ensureBody.indexOf('if (!ok)')
    const writePidIdx = ensureBody.indexOf('writeFileSync(PIDFILE')
    expect(okCheckIdx).toBeGreaterThan(-1)
    expect(writePidIdx).toBeGreaterThan(okCheckIdx)
  })
  it('orçamento de espera por readiness é configurável só por env (default inalterado: 90 tentativas de 1s)', () => {
    expect(src).toMatch(/const WAIT_TRIES = Number\(process\.env\.SUPREMO_PREVIEW_WAIT_TRIES\) \|\| 90/)
    expect(src).toMatch(/const WAIT_INTERVAL_MS = Number\(process\.env\.SUPREMO_PREVIEW_WAIT_INTERVAL_MS\) \|\| 1000/)
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

/**
 * E2E real (teste-v3-9): typecheck/lint/testes/segurança terminaram rápido,
 * mas o `build` (nível FULL) ficou minutos travado numa limitação CONHECIDA do
 * sandbox/ambiente (não erro de código) — e o checkpoint nunca saiu. A política
 * correta: só o passo `build`, e só com uma assinatura ESTRITA e conhecida
 * (porta/processo do sandbox, ou rede indisponível pra recurso externo), pode
 * ser deferido pra CI sem travar o checkpoint local. Qualquer outra coisa —
 * inclusive a MESMA assinatura aparecendo em outro passo — continua bloqueando.
 */
describe('isKnownEnvironmentalBuildFailure — assinaturas estritas (nunca heurístico amplo)', () => {
  it('bate: porta/processo já em uso pelo sandbox', () => {
    expect(isKnownEnvironmentalBuildFailure('Error: listen EADDRINUSE: address already in use :::3000')).toBe(
      true,
    )
    expect(isKnownEnvironmentalBuildFailure('bind: address already in use')).toBe(true)
  })

  it('bate: rede indisponível pra recurso externo (DNS/fetch/certificado)', () => {
    expect(isKnownEnvironmentalBuildFailure('Error: connect ENOTFOUND registry.npmjs.org')).toBe(true)
    expect(isKnownEnvironmentalBuildFailure('getaddrinfo EAI_AGAIN fonts.googleapis.com')).toBe(true)
    expect(
      isKnownEnvironmentalBuildFailure('FetchError: request to https://fonts.googleapis.com failed, reason: fetch failed'),
    ).toBe(true)
    expect(isKnownEnvironmentalBuildFailure('unable to get local issuer certificate')).toBe(true)
    expect(isKnownEnvironmentalBuildFailure('network is unreachable')).toBe(true)
  })

  it('NÃO bate: erro real de código/TypeScript/bundling/import/config — nunca vira "ambiental"', () => {
    expect(
      isKnownEnvironmentalBuildFailure("Type error: Property 'foo' does not exist on type 'Bar'."),
    ).toBe(false)
    expect(isKnownEnvironmentalBuildFailure("Module not found: Can't resolve './missing-file'")).toBe(false)
    expect(isKnownEnvironmentalBuildFailure('SyntaxError: Unexpected token )')).toBe(false)
    expect(isKnownEnvironmentalBuildFailure('ReferenceError: x is not defined')).toBe(false)
    expect(isKnownEnvironmentalBuildFailure('Invalid next.config.js options detected')).toBe(false)
  })

  it('NÃO bate: saída vazia (sem evidência nenhuma) — na dúvida, fail-closed', () => {
    expect(isKnownEnvironmentalBuildFailure('')).toBe(false)
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

/**
 * Execução REAL do `verify.mjs` gerado (não string matching) — prova o
 * comportamento fim-a-fim que os testes puros de `isKnownEnvironmentalBuildFailure`
 * não alcançam sozinhos: o passo `build` do nível FULL rodando de verdade,
 * com um `next` (shim) que falha, e o restante dos passos (typecheck/lint/
 * testes/secret scan) shimados pra sempre passar — isolando só a decisão de
 * deferir ou não o `build`.
 */
describe('verify.mjs — execução real: build ambiental defere, erro real bloqueia (v3.1 finalização)', () => {
  /** Shim executável no PATH — sai com `exitCode` e escreve `stderr` nele. */
  function writeShim(binDir: string, name: string, exitCode: number, stderr = ''): void {
    const file = join(binDir, name)
    writeFileSync(file, `#!/bin/sh\n${stderr ? `echo ${JSON.stringify(stderr)} >&2\n` : ''}exit ${exitCode}\n`, 'utf8')
    chmodSync(file, 0o755)
  }

  /**
   * Prepara um worktree isolado: `scripts/security-audit.js` real (exit 0) +
   * shims de tsc/eslint/vitest (sempre ok) + um shim de `next` configurável
   * (o único passo sob teste). PATH aponta só pro shim dir — nunca herda os
   * binários reais da máquina, então isto prova exatamente o que `verify.mjs`
   * decide sozinho.
   */
  function setupProject(nextExitCode: number, nextStderr: string): { dir: string; env: NodeJS.ProcessEnv } {
    const dir = mkdtempSync(join(tmpdir(), 'supremo-verify-e2e-'))
    // git init: reflete o worktree real (sempre um repo) e evita o `git diff`
    // do changedFiles() cair no modo --no-index (fora de repo) — irrelevante
    // pro teste (nível é forçado via CLI arg 'full'), só deixa a saída limpa.
    execFileSync('git', ['init', '-q'], { cwd: dir })
    const binDir = join(dir, 'bin')
    mkdirSync(binDir, { recursive: true })
    mkdirSync(join(dir, 'scripts'), { recursive: true })
    writeFileSync(join(dir, 'scripts', 'security-audit.js'), 'process.exit(0)\n', 'utf8')
    writeShim(binDir, 'tsc', 0)
    writeShim(binDir, 'eslint', 0)
    writeShim(binDir, 'vitest', 0)
    writeShim(binDir, 'next', nextExitCode, nextStderr)
    writeFileSync(join(dir, 'verify.mjs'), verifyScript(), 'utf8')
    return { dir, env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` } }
  }

  function runVerifyFull(dir: string, env: NodeJS.ProcessEnv): { status: number; output: string } {
    try {
      const output = execFileSync(process.execPath, [join(dir, 'verify.mjs'), 'full'], {
        cwd: dir,
        env,
        encoding: 'utf8',
      })
      return { status: 0, output }
    } catch (err) {
      const e = err as { status: number | null; stdout: string; stderr: string }
      return { status: e.status ?? 1, output: `${e.stdout}${e.stderr}` }
    }
  }

  it('build falha com assinatura CONHECIDA de limitação ambiental (porta ocupada) → DEFERE, verify sai com sucesso', () => {
    const { dir, env } = setupProject(1, 'Error: listen EADDRINUSE: address already in use :::3000')
    const { status, output } = runVerifyFull(dir, env)
    expect(status).toBe(0)
    expect(output).toContain('DEFERIDO')
    expect(output).toContain('build DEFERIDO para a CI')
  })

  it('build falha com assinatura CONHECIDA de limitação ambiental (rede p/ recurso externo) → DEFERE, verify sai com sucesso', () => {
    const { dir, env } = setupProject(1, 'FetchError: request to https://fonts.googleapis.com failed, reason: fetch failed')
    const { status, output } = runVerifyFull(dir, env)
    expect(status).toBe(0)
    expect(output).toContain('DEFERIDO')
  })

  it('build falha com erro REAL de código (TypeScript/bundling) → NUNCA defere, verify falha (fail-closed)', () => {
    const { dir, env } = setupProject(1, "Type error: Property 'foo' does not exist on type 'Bar'.")
    const { status, output } = runVerifyFull(dir, env)
    expect(status).not.toBe(0)
    expect(output).not.toContain('DEFERIDO')
    expect(output).toContain('FALHOU')
    expect(output).toContain('verify full falhou em: build')
  })

  it('build passa normalmente → verify sai com sucesso sem menção a DEFERIDO', () => {
    const { dir, env } = setupProject(0, '')
    const { status, output } = runVerifyFull(dir, env)
    expect(status).toBe(0)
    expect(output).not.toContain('DEFERIDO')
  })

  it('a mesma assinatura "ambiental" em OUTRO passo (typecheck) nunca é deferida — só build é elegível', () => {
    const dir = mkdtempSync(join(tmpdir(), 'supremo-verify-e2e-'))
    execFileSync('git', ['init', '-q'], { cwd: dir })
    const binDir = join(dir, 'bin')
    mkdirSync(binDir, { recursive: true })
    mkdirSync(join(dir, 'scripts'), { recursive: true })
    writeFileSync(join(dir, 'scripts', 'security-audit.js'), 'process.exit(0)\n', 'utf8')
    // tsc "falha" com uma mensagem que bateria no padrão ambiental — mas
    // typecheck nunca é elegível a deferir, só build.
    writeShim(binDir, 'tsc', 1, 'Error: connect ENOTFOUND registry.internal.example')
    writeShim(binDir, 'eslint', 0)
    writeShim(binDir, 'vitest', 0)
    writeShim(binDir, 'next', 0)
    writeFileSync(join(dir, 'verify.mjs'), verifyScript(), 'utf8')
    const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}` }
    const { status, output } = runVerifyFull(dir, env)
    expect(status).not.toBe(0)
    expect(output).not.toContain('DEFERIDO')
    expect(output).toContain('verify full falhou em: typecheck')
  })
})
