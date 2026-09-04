import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { previewSupervisorScript } from './harness'

/**
 * Testes de RUNTIME (não só o texto do script) para o bug real do E2E: porta
 * já ocupada por OUTRO app/processo fazia `preview:ensure` tratar a resposta
 * ALHEIA como "saudável" — falso positivo — e salvar o pid de um processo
 * nosso que podia morrer/migrar de porta sem ninguém perceber.
 *
 * Roda o script REAL gerado por `previewSupervisorScript()` (não um
 * stand-in) contra: (1) um "app alheio" — um http.createServer comum,
 * ocupando a porta ANTES do preview.mjs sequer existir, simulando outro
 * projeto/processo já rodando ali — e (2) o "dev server" de um projeto fake
 * mínimo, que é o que o preview.mjs de fato sobe via `npm run dev`. Confirma
 * que o supervisor NUNCA confunde os dois.
 */

function randomBasePort(): number {
  // Mesma convenção de lifecycle-smoke.test.ts: porta alta aleatória — reduz
  // colisão com serviços reais da máquina. Aqui precisamos de um BLOCO de
  // portas consecutivas (pra simular colisão/varredura), não só uma.
  return 20000 + Math.floor(Math.random() * 20000)
}

/** Confirma por bind-e-solta (não só sorteio) que a porta está livre AGORA —
 * pros testes de heartbeat (teste-v3-17) que exigem que o probe HTTP direto
 * genuinamente falhe: sem isso, uma colisão rara com outro teste/serviço
 * fazia o probe direto SUCEDER por acaso, quebrando a premissa do teste. */
function pickFreeTestPort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = net.createServer()
    probe.once('error', () => resolve(pickFreeTestPort()))
    probe.listen(randomBasePort(), '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : randomBasePort()
      probe.close(() => resolve(port))
    })
  })
}

function writeFixtureProject(dir: string): void {
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  writeFileSync(join(dir, 'scripts/preview.mjs'), previewSupervisorScript(), 'utf8')
  // "dev server" mínimo do projeto fake — o que preview.mjs de fato sobe via
  // `npm run dev`. Corpo ÚNICO ('OWN-DEV-SERVER') pra distinguir de um app
  // alheio na mesma porta.
  writeFileSync(
    join(dir, 'dev-server.mjs'),
    "import http from 'node:http'\n" +
      'const port = Number(process.env.PORT || 3000)\n' +
      "http.createServer((_, res) => res.end('OWN-DEV-SERVER')).listen(port, '127.0.0.1')\n",
  )
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'preview-ownership-fixture', scripts: { dev: 'node dev-server.mjs' } }),
  )
}

function runPreview(
  dir: string,
  args: string[],
  env: Record<string, string>,
  timeout = 20_000,
): { stdout: string; stderr: string; status: number | null } {
  const r = spawnSync(process.execPath, [join(dir, 'scripts/preview.mjs'), ...args], {
    cwd: dir,
    encoding: 'utf8',
    timeout,
    env: { ...process.env, ...env },
  })
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status }
}

function fetchBody(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 2000 }, (res) => {
      let body = ''
      res.on('data', (c) => (body += c))
      res.on('end', () => resolve(body))
    })
    req.on('error', reject)
    req.on('timeout', () => {
      req.destroy()
      reject(new Error('timeout'))
    })
  })
}

function readPersistedPort(dir: string): number | null {
  try {
    const n = Number(readFileSync(join(dir, '.supremo/preview.port'), 'utf8').trim())
    return Number.isFinite(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

/**
 * Reproduz o EXATO sintoma do sandbox do Codex sem depender de root/UID/
 * container: um `--require` shim que intercepta `process.kill(pid, 0)` SÓ
 * para o pid-alvo e lança um erro `EPERM` real (com `.code === 'EPERM'`) —
 * o mesmo formato de erro que o Node lança quando o SO nega o sinal. Uma
 * dependência de PID 1 (init/launchd) seria mais frágil: como root, `kill(1,
 * 0)` costuma FUNCIONAR (sem EPERM), o que quebraria o teste em containers
 * de CI rodando como root. O shim reproduz o pid REAL e vivo do preview,
 * artificialmente não-sinalizável — exatamente o que o sandbox faz.
 */
function writeEpermShim(dir: string): string {
  const shimPath = join(dir, 'eperm-shim.cjs')
  writeFileSync(
    shimPath,
    "'use strict'\n" +
      'const target = Number(process.env.SUPREMO_TEST_EPERM_PID)\n' +
      'const realKill = process.kill.bind(process)\n' +
      'process.kill = function (pid, signal) {\n' +
      '  if (Number(pid) === target && signal === 0) {\n' +
      "    const err = new Error('kill EPERM (test shim)')\n" +
      "    err.code = 'EPERM'\n" +
      '    throw err\n' +
      '  }\n' +
      '  return realKill(pid, signal)\n' +
      '}\n',
  )
  return shimPath
}

const tempDirs: string[] = []
const foreignServers: http.Server[] = []

afterAll(async () => {
  // Para qualquer instância que preview.mjs tenha subido em cada fixture.
  for (const dir of tempDirs) {
    if (existsSync(join(dir, 'scripts/preview.mjs'))) {
      spawnSync(process.execPath, [join(dir, 'scripts/preview.mjs'), 'stop'], {
        cwd: dir,
        timeout: 5000,
      })
    }
    rmSync(dir, { recursive: true, force: true })
  }
  await Promise.all(
    foreignServers.map(
      (s) =>
        new Promise<void>((resolve) => {
          s.close(() => resolve())
        }),
    ),
  )
})

function startForeignServer(
  port: number,
  body = 'FOREIGN-APP',
  host = '127.0.0.1',
): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((_, res) => res.end(body))
    server.once('error', reject)
    server.listen(port, host, () => {
      foreignServers.push(server)
      resolve(server)
    })
  })
}

// Guarda de portabilidade: se esta máquina não tiver IPv6 disponível de
// verdade (loopback ::1 nem bind), o teste de reprodução do bug de IPv6 é
// pulado em vez de falhar por um motivo alheio ao que ele testa.
function detectIpv6Loopback(): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer()
    probe.once('error', () => resolve(false))
    probe.once('listening', () => probe.close(() => resolve(true)))
    try {
      probe.listen(0, '::1')
    } catch {
      resolve(false)
    }
  })
}
const HAS_IPV6 = await detectIpv6Loopback()

describe('preview supervisor — colisão de porta + ownership (E2E real: outro app já na porta configurada)', () => {
  it(
    'porta configurada ocupada por OUTRO processo → relocaliza pra uma livre, NUNCA reporta o app alheio como saudável',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'supremo-preview-collision-'))
      tempDirs.push(dir)
      writeFixtureProject(dir)

      const foreignPort = randomBasePort()
      await startForeignServer(foreignPort)

      const result = runPreview(dir, ['ensure'], { PORT: String(foreignPort) })
      expect(result.status).toBe(0)
      // Nunca declara sucesso NA porta ocupada pelo alheio.
      expect(result.stdout).not.toContain(`http://localhost:${foreignPort}`)
      expect(result.stdout).toMatch(/ocupada por outro processo — usando/)

      const persistedPort = readPersistedPort(dir)
      expect(persistedPort).not.toBeNull()
      expect(persistedPort).not.toBe(foreignPort)

      // Ownership de verdade: quem responde na porta relocada é o NOSSO dev
      // server (corpo distinto) — o app alheio continua intacto na porta
      // original, sem ter sido tocado/matado/confundido.
      await expect(fetchBody(persistedPort!)).resolves.toBe('OWN-DEV-SERVER')
      await expect(fetchBody(foreignPort)).resolves.toBe('FOREIGN-APP')

      // status também reflete a porta REAL (relocada), nunca a configurada às cegas.
      const status = JSON.parse(runPreview(dir, ['status'], { PORT: String(foreignPort) }).stdout) as {
        running: boolean
        healthy: boolean
        port: number
      }
      expect(status.running).toBe(true)
      expect(status.healthy).toBe(true)
      expect(status.port).toBe(persistedPort)
      expect(status.port).not.toBe(foreignPort)
    },
    30_000,
  )

  it(
    'TODAS as portas do intervalo de busca ocupadas → falha CLARO (stderr + exit code != 0), nunca finge sucesso',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'supremo-preview-exhausted-'))
      tempDirs.push(dir)
      writeFixtureProject(dir)

      // PORT_SEARCH_SPAN do script gerado é 20 — ocupa a preferida + as 19
      // seguintes, então não sobra NENHUMA porta livre no intervalo.
      const basePort = randomBasePort()
      for (let p = basePort; p < basePort + 20; p++) {
        await startForeignServer(p, `FOREIGN-${p}`)
      }

      const result = runPreview(dir, ['ensure'], { PORT: String(basePort) })
      expect(result.status).not.toBe(0)
      expect(result.stderr).toMatch(/ocupadas/)
      expect(result.stdout).not.toMatch(/✓ preview no ar/)
      expect(readPersistedPort(dir)).toBeNull()
    },
    60_000,
  )

  // Achado específico do E2E real que a v1 deste fix não cobria: um
  // `python3 -m http.server 3000` ocupou *:3000 via IPv6 (`::`), o bind-probe
  // ERA só IPv4 (127.0.0.1) — considerou a porta livre, persistiu
  // preview.port = 3000, e o preview real morreu ao colidir de verdade com
  // o wildcard IPv6 ao subir. Reproduz especificamente isso: um foreign
  // server só no wildcard IPv6 (nenhum IPv4), e confirma que agora é
  // detectado e o preview escolhe a PRÓXIMA porta (o mesmo "3000 ocupado →
  // 3001 escolhido" do relatório real, usando uma base aleatória por
  // segurança de CI — ver randomBasePort()).
  it.skipIf(!HAS_IPV6)(
    'foreign server SÓ no wildcard IPv6 (::), sem nada em IPv4 → detectado como ocupado, preview escolhe a PRÓXIMA porta (3001 relativo à ocupada)',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'supremo-preview-ipv6-'))
      tempDirs.push(dir)
      writeFixtureProject(dir)

      const foreignPort = randomBasePort()
      // '::' = wildcard IPv6 — o MESMO que `python3 -m http.server` usou no
      // E2E real. NUNCA bindamos em 127.0.0.1 aqui — é exatamente a ausência
      // de qualquer ocupante IPv4 que fazia o probe antigo (IPv4-only)
      // reportar "livre" incorretamente.
      await startForeignServer(foreignPort, 'FOREIGN-IPV6-APP', '::')

      const result = runPreview(dir, ['ensure'], { PORT: String(foreignPort) })
      expect(result.status).toBe(0)
      // Nunca declara sucesso na porta ocupada (via IPv6) pelo alheio.
      expect(result.stdout).not.toContain(`http://localhost:${foreignPort}`)
      expect(result.stdout).toMatch(/ocupada por outro processo — usando/)

      const persistedPort = readPersistedPort(dir)
      // Só a porta base está ocupada (só em IPv6) — a próxima já está livre
      // nas duas famílias, então a escolha é EXATAMENTE foreignPort + 1.
      expect(persistedPort).toBe(foreignPort + 1)

      // Ownership real: quem responde na porta escolhida é o NOSSO dev
      // server — o app alheio em IPv6 continua intacto, sem ter sido tocado.
      await expect(fetchBody(persistedPort!)).resolves.toBe('OWN-DEV-SERVER')
    },
    30_000,
  )

  // E2E real: preview:ensure dentro do sandbox do Codex. Um preview saudável
  // sobreviveu entre "prompts" (pid antigo, porta antiga), mas o prompt
  // seguinte rodou em outro contexto de sandbox onde process.kill(pid, 0) no
  // pid antigo deu EPERM (não ESRCH) — o processo seguia vivo e saudável, só
  // não sinalizável DAQUELE contexto. O supervisor tratava EPERM como
  // "morto" e sobrescrevia .supremo/preview.pid/.port pro pid/porta de uma
  // candidata nova (que morreu com `listen EPERM`) — perdendo o rastro da
  // instância antiga, que seguia rodando (órfã, sem ninguém apontando pra
  // ela). Reproduz isso com o pid REAL do preview (via shim — ver
  // writeEpermShim) e confirma: reusa, nunca mata, nunca sobrescreve.
  it(
    'kill(pid,0) retorna EPERM (pid existe, só não é sinalizável — ex.: sandbox) + trackedPort saudável → REUSA, nunca mata nem sobrescreve nada',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'supremo-preview-eperm-'))
      tempDirs.push(dir)
      writeFixtureProject(dir)
      const shimPath = writeEpermShim(dir)

      const port = randomBasePort()
      const first = runPreview(dir, ['ensure'], { PORT: String(port) })
      expect(first.status).toBe(0)
      const realPid = readFileSync(join(dir, '.supremo/preview.pid'), 'utf8').trim()
      expect(readPersistedPort(dir)).toBe(port)

      // Segundo "prompt": mesmo pid real, mas agora kill(realPid, 0) dá
      // EPERM (simulando o novo contexto de sandbox) — nunca ESRCH.
      const second = spawnSync(
        process.execPath,
        ['--require', shimPath, join(dir, 'scripts/preview.mjs'), 'ensure'],
        {
          cwd: dir,
          encoding: 'utf8',
          timeout: 20_000,
          env: { ...process.env, PORT: String(port), SUPREMO_TEST_EPERM_PID: realPid },
        },
      )
      expect(second.status).toBe(0)
      expect(second.stdout).toMatch(/já no ar/)
      // Nunca declara sucesso apontando pra uma porta nova/diferente —
      // nenhuma tentativa de relocar ou subir por cima aconteceu.
      expect(second.stdout).not.toMatch(/ocupada por outro processo/)

      // O processo REAL (nosso, do primeiro ensure()) segue vivo — nunca foi
      // morto nem substituído por uma segunda instância. Sinalizável de
      // verdade pelo processo de teste (que não tem o shim — kill(realPid,0)
      // aqui reflete o SO de verdade, não a simulação).
      expect(() => process.kill(Number(realPid), 0)).not.toThrow()
      await expect(fetchBody(port)).resolves.toBe('OWN-DEV-SERVER')

      // O estado gravado continua sendo o da instância REAL — nunca foi
      // sobrescrito por nada relacionado à tentativa "EPERM".
      expect(readFileSync(join(dir, '.supremo/preview.pid'), 'utf8').trim()).toBe(realPid)
      expect(readPersistedPort(dir)).toBe(port)

      // status também reconhece a instância como saudável — running/healthy
      // vêm da porta rastreada respondendo, não de conseguir sinalizar o pid.
      const status = JSON.parse(runPreview(dir, ['status'], { PORT: String(port) }).stdout) as {
        running: boolean
        healthy: boolean
        port: number
      }
      expect(status.running).toBe(true)
      expect(status.healthy).toBe(true)
      expect(status.port).toBe(port)
    },
    30_000,
  )

  // Segunda metade do mesmo E2E: mesmo SEM o angle do EPERM, uma candidata
  // nova que não fica saudável (ex.: `listen EPERM` real no sandbox) NUNCA
  // pode sobrescrever um estado anterior válido. Reproduz com uma instância
  // real morta (pid genuinamente ESRCH — não precisa do shim aqui) + um dev
  // script que nunca binda em lugar nenhum, e confirma que o pid/porta
  // antigos (agora só um REGISTRO stale, mas ainda assim o único que temos)
  // continuam intactos — nunca substituídos pelo pid/porta da tentativa que
  // falhou.
  it(
    'candidata nova NÃO fica saudável (nunca binda) → NUNCA sobrescreve .supremo/preview.pid|.port com a tentativa falha',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'supremo-preview-preserve-'))
      tempDirs.push(dir)
      writeFixtureProject(dir)

      const port = randomBasePort()
      const first = runPreview(dir, ['ensure'], { PORT: String(port) })
      expect(first.status).toBe(0)
      const realPid = readFileSync(join(dir, '.supremo/preview.pid'), 'utf8').trim()
      expect(readPersistedPort(dir)).toBe(port)

      // Mata a instância de verdade (ESRCH genuíno na próxima checagem) —
      // simula a instância antiga tendo morrido de fato entre "prompts". O
      // pidfile/portfile continuam com os valores antigos (nada os reescreve
      // sozinho).
      process.kill(Number(realPid))
      for (let i = 0; i < 50; i++) {
        try {
          process.kill(Number(realPid), 0)
          await new Promise((r) => setTimeout(r, 50))
        } catch {
          break
        }
      }

      // Troca o dev script por um que NUNCA binda em porta nenhuma (simula
      // `listen EPERM` real do sandbox — o efeito observável é o mesmo:
      // a candidata nunca fica saudável).
      writeFileSync(
        join(dir, 'dev-server.mjs'),
        "process.stdout.write('nunca vou bindar em nada\\n')\n",
      )

      // WAIT_TRIES/INTERVAL rápidos só pra este teste não esperar o
      // orçamento de produção (até 90s) — default de produção inalterado
      // (ver harness.test.ts: 90 tentativas de 1s sem a env).
      const second = runPreview(dir, ['ensure'], {
        PORT: String(port),
        SUPREMO_PREVIEW_WAIT_TRIES: '3',
        SUPREMO_PREVIEW_WAIT_INTERVAL_MS: '100',
      })
      expect(second.status).toBe(0)
      expect(second.stdout).toMatch(/mantendo estado anterior/)
      expect(second.stdout).not.toMatch(/✓ preview no ar/)

      // O estado NÃO foi sobrescrito pela tentativa que falhou — continua
      // sendo exatamente o da instância antiga (agora morta, mas preservada
      // — nunca trocada por um pid/porta que sabemos que morreram).
      expect(readFileSync(join(dir, '.supremo/preview.pid'), 'utf8').trim()).toBe(realPid)
      expect(readPersistedPort(dir)).toBe(port)
    },
    30_000,
  )

  it(
    'porta preferida LIVRE (caso comum) → sobe nela mesma, sem qualquer relocalização — comportamento existente intacto',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'supremo-preview-free-'))
      tempDirs.push(dir)
      writeFixtureProject(dir)

      const port = randomBasePort()
      const first = runPreview(dir, ['ensure'], { PORT: String(port) })
      expect(first.status).toBe(0)
      expect(first.stdout).toContain(`http://localhost:${port}`)
      expect(first.stdout).not.toMatch(/ocupada por outro processo/)
      expect(readPersistedPort(dir)).toBe(port)
      await expect(fetchBody(port)).resolves.toBe('OWN-DEV-SERVER')

      // ensure() de novo, mesma instância viva e saudável → REUSA (mesmo pid),
      // não sobe uma segunda instância — regressão do comportamento original.
      const pidAfterFirst = readFileSync(join(dir, '.supremo/preview.pid'), 'utf8').trim()
      const second = runPreview(dir, ['ensure'], { PORT: String(port) })
      expect(second.status).toBe(0)
      expect(second.stdout).toMatch(/já no ar/)
      const pidAfterSecond = readFileSync(join(dir, '.supremo/preview.pid'), 'utf8').trim()
      expect(pidAfterSecond).toBe(pidAfterFirst)
    },
    30_000,
  )

  // E2E real (teste-v3-16): daemon saudável, preview `running=true`, mas o
  // preflight reportava `healthy=false` e fail-closed — no MESMO instante,
  // `curl localhost:PORTA`/o browser do host respondiam 200. Causa: o
  // healthcheck testava SÓ 127.0.0.1; em sandboxes cujo netstack não é
  // dual-stack de verdade, um dev server que bindou no wildcard `::` pode
  // aceitar `::1`/`localhost` e recusar `127.0.0.1`. Reproduzido aqui de
  // forma determinística (não depende de nenhuma config específica de
  // sandbox): nosso PRÓPRIO dev server bindando SÓ em `::1` — `fetchBody`
  // (IPv4-only, mesmo formato do health() antigo) falha de verdade contra
  // ele, provando a corrida é real — mas `ensure`/`status` (health()
  // corrigido, testa as duas famílias) continuam reportando saudável.
  it.skipIf(!HAS_IPV6)(
    'nosso PRÓPRIO dev server só aceita ::1 (nunca 127.0.0.1) → ensure/status consideram saudável — antes: falso negativo (teste-v3-16)',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'supremo-preview-ipv6only-'))
      tempDirs.push(dir)
      mkdirSync(join(dir, 'scripts'), { recursive: true })
      writeFileSync(join(dir, 'scripts/preview.mjs'), previewSupervisorScript(), 'utf8')
      writeFileSync(
        join(dir, 'dev-server.mjs'),
        "import http from 'node:http'\n" +
          'const port = Number(process.env.PORT || 3000)\n' +
          "http.createServer((_, res) => res.end('OWN-DEV-SERVER')).listen(port, '::1')\n",
      )
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({ name: 'preview-ipv6only-fixture', scripts: { dev: 'node dev-server.mjs' } }),
      )

      const port = randomBasePort()
      const ensureResult = runPreview(dir, ['ensure'], { PORT: String(port) })
      expect(ensureResult.status).toBe(0)
      // ensure() confirmou saudável ANTES de gravar o estado — se o health()
      // antigo (127.0.0.1-only) estivesse em vigor, isto teria impresso "não
      // respondeu" e NUNCA gravado pidfile/portfile (ver startDetached()).
      expect(ensureResult.stdout).toMatch(/preview no ar/)
      expect(readPersistedPort(dir)).toBe(port)

      // Prova direta da corrida: um probe IPv4-only (mesmo formato do
      // health() antigo) contra o MESMO processo/porta falha de verdade.
      await expect(fetchBody(port)).rejects.toThrow()

      // status() — a mesma checagem que supremo-status.mjs usa via `preview
      // status` — ainda assim reporta saudável: o servidor RESPONDE de
      // verdade, só não por essa família específica.
      const status = JSON.parse(runPreview(dir, ['status'], { PORT: String(port) }).stdout) as {
        running: boolean
        healthy: boolean
      }
      expect(status.running).toBe(true)
      expect(status.healthy).toBe(true)
    },
    30_000,
  )

  // Companion do teste acima: fail-closed continua intacto quando NENHUMA
  // família responde de verdade — a correção do v3-16 nunca "inventa" saúde,
  // só deixa de ignorar uma família que responde de verdade.
  it(
    'processo vivo mas NADA escuta na porta rastreada (nenhuma família) → status continua reportando não-saudável (fail-closed preservado)',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'supremo-preview-genuinely-down-'))
      // NÃO entra em tempDirs de propósito: o afterAll ali chama `preview.mjs
      // stop`, que manda process.kill(pid) (SIGTERM de verdade) no pid
      // registrado — aqui o pid é um processo idle criado só pra este teste
      // (nunca o processo de teste em si); matamos e limpamos manualmente.
      mkdirSync(join(dir, '.supremo'), { recursive: true })
      mkdirSync(join(dir, 'scripts'), { recursive: true })
      writeFileSync(join(dir, 'scripts/preview.mjs'), previewSupervisorScript(), 'utf8')

      const port = randomBasePort()
      // Processo REAL e vivo, mas que não escuta porta nenhuma — running=true
      // vem de process.kill(pid,0); a prova real de saúde precisa vir do
      // healthcheck (as DUAS famílias tentadas, nenhuma responde), não do
      // pid sozinho.
      const idle = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        detached: true,
        stdio: 'ignore',
      })
      idle.unref()
      try {
        writeFileSync(join(dir, '.supremo/preview.pid'), String(idle.pid))
        writeFileSync(join(dir, '.supremo/preview.port'), String(port))

        const status = JSON.parse(runPreview(dir, ['status'], { PORT: String(port) }).stdout) as {
          running: boolean
          healthy: boolean
        }
        expect(status.running).toBe(true)
        expect(status.healthy).toBe(false)
      } finally {
        try {
          if (idle.pid) process.kill(idle.pid)
        } catch {
          /* já morto */
        }
        rmSync(dir, { recursive: true, force: true })
      }
    },
    15_000,
  )
})

/**
 * Heartbeat co-localizado (E2E real, teste-v3-17) — causa raiz confirmada:
 * `health()` roda num subprocesso NOVO a cada `supremo:resume`, e no
 * sandbox real (Codex) cada comando do agente ganha seu PRÓPRIO namespace
 * de rede, isolado de onde o `next dev` de verdade está escutando — daemon
 * healthy, preview `running=true` (PID, já tolerante — ver testes acima),
 * mas `healthy=false` PARA SEMPRE, mesmo com o browser do host respondendo
 * 200 no MESMO instante. Testar mais famílias de endereço (v3.4.5) não
 * ajuda: nenhum endereço, de nenhuma família, alcança o processo real
 * DENTRO desse namespace isolado.
 *
 * Fix: `ensure()` sobe um heartbeat DESACOPLADO no MESMO comando que
 * confirmou o servidor saudável pela 1ª vez (mesmo namespace, garantido) —
 * ele sonda `health()` periodicamente e persiste o resultado em
 * `.supremo/preview.health.json`. Comandos FUTUROS (`status`/`ensure`, em
 * QUALQUER namespace) confiam nesse heartbeat ANTES de tentar seu próprio
 * probe HTTP direto.
 *
 * Os testes abaixo reproduzem a corrida de forma DETERMINÍSTICA — sem
 * depender de nenhuma config específica de sandbox — craftando o estado
 * exato do sintoma: um probe HTTP direto que genuinamente falha (porta sem
 * nada escutando, o mesmo efeito observável de "este comando está isolado
 * da porta real") ao lado de um heartbeat FRESCO escrito por quem tinha
 * acesso real ao servidor.
 */
describe('preview supervisor — heartbeat co-localizado (E2E real: probe isolado do namespace real, teste-v3-17)', () => {
  // pid/instanceId (teste-v3-17b): o heartbeat só é confiado se descrever a
  // MESMA instância rastreada agora — por isso todo fixture escreve os DOIS,
  // e writeInstanceFile permite construir cenários de descompasso de
  // propósito (pid errado, instanceId errado, ou nenhum registrado).
  function writeHealthFile(dir: string, healthy: boolean, ageMs: number, pid: number, instanceId: string): void {
    mkdirSync(join(dir, '.supremo'), { recursive: true })
    writeFileSync(
      join(dir, '.supremo/preview.health.json'),
      JSON.stringify({ healthy, checkedAt: Date.now() - ageMs, pid, instanceId }),
    )
  }
  function writeInstanceFile(dir: string, instanceId: string): void {
    mkdirSync(join(dir, '.supremo'), { recursive: true })
    writeFileSync(join(dir, '.supremo/preview.instance'), instanceId)
  }

  function spawnIdleProcess(): ReturnType<typeof spawn> {
    const idle = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: 'ignore',
    })
    idle.unref()
    return idle
  }

  // Depois de matar um pid, ele fica ZUMBI até o processo do teste (pai real,
  // via spawn()) reapá-lo — kill(pid,0) continua sem lançar até isso
  // acontecer, mesmo com o processo já morto. Espera de verdade em vez de
  // checar na hora (que corria risco de flakiness por essa janela).
  async function waitUntilDead(pid: number, timeoutMs = 5000): Promise<boolean> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      try {
        process.kill(pid, 0)
      } catch {
        return true
      }
      await new Promise((r) => setTimeout(r, 50))
    }
    return false
  }

  it(
    'heartbeat real: ensure() sobe um escritor que mantém preview.health.json fresco enquanto o processo vive',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'supremo-preview-heartbeat-real-'))
      tempDirs.push(dir)
      writeFixtureProject(dir)
      const port = randomBasePort()

      const result = runPreview(dir, ['ensure'], {
        PORT: String(port),
        SUPREMO_PREVIEW_HEARTBEAT_INTERVAL_MS: '150',
      })
      expect(result.status).toBe(0)

      // Só o waitReady() já grava o heartbeat na hora — nem precisa esperar
      // o escritor desacoplado ter seu 1º tick.
      const first = JSON.parse(readFileSync(join(dir, '.supremo/preview.health.json'), 'utf8')) as {
        healthy: boolean
        checkedAt: number
      }
      expect(first.healthy).toBe(true)
      expect(Date.now() - first.checkedAt).toBeLessThan(2_000)

      // Espera o escritor desacoplado ticar de verdade (intervalo curto só
      // pro teste) e confirma que o heartbeat continua sendo REESCRITO, não
      // é só a escrita inicial do ensure().
      await new Promise((r) => setTimeout(r, 400))
      const second = JSON.parse(readFileSync(join(dir, '.supremo/preview.health.json'), 'utf8')) as {
        healthy: boolean
        checkedAt: number
      }
      expect(second.healthy).toBe(true)
      expect(second.checkedAt).toBeGreaterThan(first.checkedAt)
    },
    30_000,
  )

  it(
    'probe HTTP direto falha (nada escuta na porta rastreada) mas heartbeat fresco diz saudável → status() AINDA reporta healthy:true',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'supremo-preview-heartbeat-rescue-'))
      tempDirs.push(dir)
      mkdirSync(join(dir, '.supremo'), { recursive: true })
      mkdirSync(join(dir, 'scripts'), { recursive: true })
      writeFileSync(join(dir, 'scripts/preview.mjs'), previewSupervisorScript(), 'utf8')
      const port = await pickFreeTestPort()
      const idle = spawnIdleProcess()

      try {
        writeFileSync(join(dir, '.supremo/preview.pid'), String(idle.pid))
        writeFileSync(join(dir, '.supremo/preview.port'), String(port))
        writeInstanceFile(dir, 'instance-rescue')
        writeHealthFile(dir, true, 500, idle.pid!, 'instance-rescue') // fresco — dentro da janela padrão de 5s

        const status = JSON.parse(runPreview(dir, ['status'], { PORT: String(port) }).stdout) as {
          running: boolean
          healthy: boolean
        }
        expect(status.running).toBe(true)
        expect(status.healthy).toBe(true)
      } finally {
        try {
          if (idle.pid) process.kill(idle.pid)
        } catch {
          /* já morto */
        }
      }
    },
    15_000,
  )

  it(
    'heartbeat VELHO demais (além de HEALTH_STALE_MS) + probe direto falhando → status() reporta healthy:false (fail-closed)',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'supremo-preview-heartbeat-stale-'))
      tempDirs.push(dir)
      mkdirSync(join(dir, '.supremo'), { recursive: true })
      mkdirSync(join(dir, 'scripts'), { recursive: true })
      writeFileSync(join(dir, 'scripts/preview.mjs'), previewSupervisorScript(), 'utf8')
      const port = await pickFreeTestPort()
      const idle = spawnIdleProcess()

      try {
        writeFileSync(join(dir, '.supremo/preview.pid'), String(idle.pid))
        writeFileSync(join(dir, '.supremo/preview.port'), String(port))
        writeInstanceFile(dir, 'instance-stale')
        // Escrito há mais tempo que o teto configurado — nunca confiado.
        writeHealthFile(dir, true, 10_000, idle.pid!, 'instance-stale')

        const status = JSON.parse(
          runPreview(dir, ['status'], { PORT: String(port), SUPREMO_PREVIEW_HEALTH_STALE_MS: '5000' }).stdout,
        ) as { running: boolean; healthy: boolean }
        expect(status.running).toBe(true)
        expect(status.healthy).toBe(false)
      } finally {
        try {
          if (idle.pid) process.kill(idle.pid)
        } catch {
          /* já morto */
        }
      }
    },
    15_000,
  )

  it(
    'ensure() com heartbeat fresco mas probe direto falhando → REUSA (nunca mata nem substitui a instância saudável de verdade)',
    async () => {
      // Prova a parte mais perigosa do bug: sem o heartbeat, decide() veria
      // pidAlive=true + healthy=false (o probe isolado falhando) e mandaria
      // 'restart' — matando um processo PERFEITAMENTE saudável só porque
      // ESTE comando não conseguia alcançá-lo, e subindo outra instância
      // (que, no sandbox real, ficaria IGUALMENTE inalcançável do próximo
      // comando — um ciclo sem fim de reinícios inúteis).
      const dir = mkdtempSync(join(tmpdir(), 'supremo-preview-heartbeat-noKill-'))
      tempDirs.push(dir)
      mkdirSync(join(dir, '.supremo'), { recursive: true })
      mkdirSync(join(dir, 'scripts'), { recursive: true })
      writeFileSync(join(dir, 'scripts/preview.mjs'), previewSupervisorScript(), 'utf8')
      const port = await pickFreeTestPort()
      const idle = spawnIdleProcess()

      try {
        writeFileSync(join(dir, '.supremo/preview.pid'), String(idle.pid))
        writeFileSync(join(dir, '.supremo/preview.port'), String(port))
        writeInstanceFile(dir, 'instance-nokill')
        writeHealthFile(dir, true, 500, idle.pid!, 'instance-nokill')

        const result = runPreview(dir, ['ensure'], { PORT: String(port) })
        expect(result.status).toBe(0)
        expect(result.stdout).toMatch(/já no ar/)
        expect(result.stdout).not.toMatch(/ocupada por outro processo/)

        // O idle original segue vivo, intocado — nunca foi morto/substituído.
        expect(() => process.kill(idle.pid!, 0)).not.toThrow()
        expect(readFileSync(join(dir, '.supremo/preview.pid'), 'utf8').trim()).toBe(String(idle.pid))
      } finally {
        try {
          if (idle.pid) process.kill(idle.pid)
        } catch {
          /* já morto */
        }
      }
    },
    15_000,
  )

  it(
    'sem heartbeat nenhum + probe direto falhando → status() continua reportando healthy:false (comportamento padrão preservado)',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'supremo-preview-heartbeat-absent-'))
      tempDirs.push(dir)
      mkdirSync(join(dir, '.supremo'), { recursive: true })
      mkdirSync(join(dir, 'scripts'), { recursive: true })
      writeFileSync(join(dir, 'scripts/preview.mjs'), previewSupervisorScript(), 'utf8')
      const port = await pickFreeTestPort()
      const idle = spawnIdleProcess()

      try {
        writeFileSync(join(dir, '.supremo/preview.pid'), String(idle.pid))
        writeFileSync(join(dir, '.supremo/preview.port'), String(port))
        // Nenhum preview.health.json escrito.

        const status = JSON.parse(runPreview(dir, ['status'], { PORT: String(port) }).stdout) as {
          healthy: boolean
        }
        expect(status.healthy).toBe(false)
      } finally {
        try {
          if (idle.pid) process.kill(idle.pid)
        } catch {
          /* já morto */
        }
      }
    },
    15_000,
  )

  it(
    'heartbeat fresco + healthy=true mas com PID DIFERENTE do rastreado agora → rejeitado (nunca um falso positivo por pid reaproveitado, teste-v3-17b)',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'supremo-preview-heartbeat-pidmismatch-'))
      tempDirs.push(dir)
      mkdirSync(join(dir, '.supremo'), { recursive: true })
      mkdirSync(join(dir, 'scripts'), { recursive: true })
      writeFileSync(join(dir, 'scripts/preview.mjs'), previewSupervisorScript(), 'utf8')
      const port = await pickFreeTestPort()
      const idle = spawnIdleProcess()

      try {
        writeFileSync(join(dir, '.supremo/preview.pid'), String(idle.pid))
        writeFileSync(join(dir, '.supremo/preview.port'), String(port))
        writeInstanceFile(dir, 'instance-pidmismatch')
        // O heartbeat descreve um pid QUALQUER, nunca o que está rastreado
        // agora — nem chega a ser "de outra instância nossa", é só um número
        // diferente. Isolado, um heartbeat assim é indistinguível de um pid
        // reaproveitado pelo SO depois que o processo original morreu.
        writeHealthFile(dir, true, 500, idle.pid! + 1, 'instance-pidmismatch')

        const status = JSON.parse(runPreview(dir, ['status'], { PORT: String(port) }).stdout) as {
          running: boolean
          healthy: boolean
        }
        expect(status.running).toBe(true)
        expect(status.healthy).toBe(false)
      } finally {
        try {
          if (idle.pid) process.kill(idle.pid)
        } catch {
          /* já morto */
        }
      }
    },
    15_000,
  )

  it(
    'heartbeat fresco + healthy=true + PID certo, mas instanceId NÃO bate com o token registrado agora → rejeitado (teste-v3-17b)',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'supremo-preview-heartbeat-instancemismatch-'))
      tempDirs.push(dir)
      mkdirSync(join(dir, '.supremo'), { recursive: true })
      mkdirSync(join(dir, 'scripts'), { recursive: true })
      writeFileSync(join(dir, 'scripts/preview.mjs'), previewSupervisorScript(), 'utf8')
      const port = await pickFreeTestPort()
      const idle = spawnIdleProcess()

      try {
        writeFileSync(join(dir, '.supremo/preview.pid'), String(idle.pid))
        writeFileSync(join(dir, '.supremo/preview.port'), String(port))
        writeInstanceFile(dir, 'instance-CORRENTE')
        // Pid bate, mas o token da instância no heartbeat é de uma geração
        // ANTERIOR (ex.: um heartbeat writer órfão que ainda não notou que
        // foi substituído) — mesmo pid não basta sozinho.
        writeHealthFile(dir, true, 500, idle.pid!, 'instance-ANTIGA')

        const status = JSON.parse(runPreview(dir, ['status'], { PORT: String(port) }).stdout) as {
          running: boolean
          healthy: boolean
        }
        expect(status.running).toBe(true)
        expect(status.healthy).toBe(false)
      } finally {
        try {
          if (idle.pid) process.kill(idle.pid)
        } catch {
          /* já morto */
        }
      }
    },
    15_000,
  )

  it(
    'heartbeat com pid certo mas NENHUMA instância registrada (.supremo/preview.instance ausente) → rejeitado, nunca aceito "por padrão" (teste-v3-17b)',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'supremo-preview-heartbeat-noinstance-'))
      tempDirs.push(dir)
      mkdirSync(join(dir, '.supremo'), { recursive: true })
      mkdirSync(join(dir, 'scripts'), { recursive: true })
      writeFileSync(join(dir, 'scripts/preview.mjs'), previewSupervisorScript(), 'utf8')
      const port = await pickFreeTestPort()
      const idle = spawnIdleProcess()

      try {
        writeFileSync(join(dir, '.supremo/preview.pid'), String(idle.pid))
        writeFileSync(join(dir, '.supremo/preview.port'), String(port))
        // Nenhum writeInstanceFile() — .supremo/preview.instance não existe.
        writeHealthFile(dir, true, 500, idle.pid!, 'instance-orfa')

        const status = JSON.parse(runPreview(dir, ['status'], { PORT: String(port) }).stdout) as {
          running: boolean
          healthy: boolean
        }
        expect(status.running).toBe(true)
        expect(status.healthy).toBe(false)
      } finally {
        try {
          if (idle.pid) process.kill(idle.pid)
        } catch {
          /* já morto */
        }
      }
    },
    15_000,
  )

  it(
    'restart (candidata anterior zumbi) invalida heartbeat/token da instância ANTERIOR — a instância NOVA nunca herda pid/instanceId velhos (teste-v3-17b)',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'supremo-preview-heartbeat-restart-instance-'))
      tempDirs.push(dir)
      writeFixtureProject(dir)
      const port = await pickFreeTestPort()
      // Zumbi: pid vivo, mas não é quem serve a porta rastreada — nada
      // escuta nela, então o probe direto falha de verdade.
      const idle = spawnIdleProcess()

      try {
        mkdirSync(join(dir, '.supremo'), { recursive: true })
        writeFileSync(join(dir, '.supremo/preview.pid'), String(idle.pid))
        writeFileSync(join(dir, '.supremo/preview.port'), String(port))
        writeInstanceFile(dir, 'instance-STALE-leftover')
        // Heartbeat de um pid alheio (nem é o zumbi) — nunca seria confiado
        // de qualquer forma (pid não bate), então decide() vê
        // pidAlive=true (zumbi) + healthy=false → 'restart'.
        writeHealthFile(dir, true, 500, 999_999, 'instance-STALE-leftover')

        const result = runPreview(dir, ['ensure'], { PORT: String(port) }, 30_000)
        expect(result.status).toBe(0)
        expect(result.stdout).toMatch(/preview no ar/)

        // O zumbi original foi morto — nunca confundido com a instância nova.
        expect(await waitUntilDead(idle.pid!)).toBe(true)

        const newInstance = readFileSync(join(dir, '.supremo/preview.instance'), 'utf8').trim()
        const newPid = Number(readFileSync(join(dir, '.supremo/preview.pid'), 'utf8').trim())
        const health = JSON.parse(readFileSync(join(dir, '.supremo/preview.health.json'), 'utf8')) as {
          healthy: boolean
          pid: number
          instanceId: string
        }
        // A instância NOVA nunca herda o token/pid da anterior invalidada —
        // e o heartbeat gravado descreve EXATAMENTE a instância nova.
        expect(newInstance).not.toBe('instance-STALE-leftover')
        expect(newPid).not.toBe(idle.pid)
        expect(newPid).not.toBe(999_999)
        expect(health.healthy).toBe(true)
        expect(health.pid).toBe(newPid)
        expect(health.instanceId).toBe(newInstance)
      } finally {
        try {
          if (idle.pid) process.kill(idle.pid)
        } catch {
          /* já morto */
        }
        try {
          const trackedPid = Number(readFileSync(join(dir, '.supremo/preview.pid'), 'utf8').trim())
          if (trackedPid) process.kill(trackedPid)
        } catch {
          /* já morto */
        }
      }
    },
    30_000,
  )

  it(
    'heartbeat é escrito ATOMICAMENTE — depois de ensure(), nenhum arquivo .tmp sobra e o JSON está sempre completo e consistente com pid/instância registrados (teste-v3-17b)',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'supremo-preview-heartbeat-atomic-'))
      tempDirs.push(dir)
      writeFixtureProject(dir)
      const port = await pickFreeTestPort()

      const result = runPreview(dir, ['ensure'], { PORT: String(port) }, 30_000)
      try {
        expect(result.status).toBe(0)

        const entries = readdirSync(join(dir, '.supremo'))
        expect(entries.some((f) => f.endsWith('.tmp'))).toBe(false)

        const pid = Number(readFileSync(join(dir, '.supremo/preview.pid'), 'utf8').trim())
        const instanceId = readFileSync(join(dir, '.supremo/preview.instance'), 'utf8').trim()
        const health = JSON.parse(readFileSync(join(dir, '.supremo/preview.health.json'), 'utf8')) as {
          healthy: boolean
          checkedAt: number
          pid: number
          instanceId: string
        }
        expect(health.healthy).toBe(true)
        expect(health.pid).toBe(pid)
        expect(health.instanceId).toBe(instanceId)
        expect(Number.isFinite(health.checkedAt)).toBe(true)
      } finally {
        try {
          const trackedPid = Number(readFileSync(join(dir, '.supremo/preview.pid'), 'utf8').trim())
          if (trackedPid) process.kill(trackedPid)
        } catch {
          /* já morto */
        }
      }
    },
    30_000,
  )
})
