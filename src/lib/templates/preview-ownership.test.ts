import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
})
