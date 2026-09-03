import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
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

function startForeignServer(port: number, body = 'FOREIGN-APP'): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((_, res) => res.end(body))
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      foreignServers.push(server)
      resolve(server)
    })
  })
}

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
