import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { previewSupervisorScript } from './harness'

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Missing test port')
      server.close(() => resolve(address.port))
    })
  })
}

function request(port: number, cookieBytes: number): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get({
      host: '127.0.0.1', port, path: '/', timeout: 3000, agent: false,
      headers: { cookie: `preview_probe=${'x'.repeat(cookieBytes)}` },
    }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => { body += chunk })
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body }))
    })
    req.once('error', (error: NodeJS.ErrnoException) => {
      // O parser pode encerrar o socket enquanto o cliente ainda transmite um
      // header acima do teto, antes de o cliente receber o HTTP 431 inteiro.
      if (error.code === 'ECONNRESET') resolve({ status: 0, body: 'connection-reset' })
      else reject(error)
    })
    req.once('timeout', () => req.destroy(new Error('Fixture request timeout')))
  })
}

describe('preview local — capacidade HTTP com cookies de vários projetos', () => {
  it.each([
    { name: 'padrão', options: '', limit: 65536, recovery: true },
    { name: 'opções preexistentes', options: '--no-warnings', limit: 65536, recovery: true },
    { name: 'limite explícito com igual', options: '--max-http-header-size=32768', limit: 32768 },
    { name: 'limite explícito separado', options: '--max-http-header-size 24576', limit: 24576 },
    { name: 'limite explícito entre aspas', options: '"--max-http-header-size=32768"', limit: 32768 },
    { name: 'limite explícito com underscore', options: '--max_http_header_size=24576', limit: 24576 },
    { name: 'limite explícito menor preservado', options: '--max-http-header-size=8192', limit: 8192 },
    { name: 'produção preservada', options: '', limit: http.maxHeaderSize, environment: 'production' as const },
  ])('$name: servidor real respeita o limite e preserva as opções', async ({ options, limit, recovery, environment }) => {
    const dir = mkdtempSync(join(tmpdir(), 'supremo-header-capacity-'))
    const port = await freePort()
    const inheritedOptions = process.env.NODE_OPTIONS
    mkdirSync(join(dir, 'scripts'))
    writeFileSync(join(dir, 'scripts/preview.mjs'), previewSupervisorScript())
    writeFileSync(join(dir, 'retained-option.cjs'), 'globalThis.previewOptionRetained = true\n')
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'node server.mjs' } }))
    writeFileSync(join(dir, 'server.mjs'), `
      import http from 'node:http'
      http.createServer((request, response) => response.end(JSON.stringify({
        limit: http.maxHeaderSize,
        retained: globalThis.previewOptionRetained === true,
        nodeOptions: process.env.NODE_OPTIONS,
      }))).listen(Number(process.env.PORT), '127.0.0.1')
    `)
    const originalOptions = `${options} --require="${join(dir, 'retained-option.cjs')}"`.trim()
    const env: NodeJS.ProcessEnv = {
      ...process.env, NODE_ENV: environment ?? 'development', PORT: String(port), NODE_OPTIONS: originalOptions,
      SUPREMO_PREVIEW_WAIT_INTERVAL_MS: '50', SUPREMO_PREVIEW_WAIT_TRIES: '100',
    }
    try {
      const result = spawnSync(process.execPath, ['scripts/preview.mjs', 'ensure'], {
        cwd: dir, env, encoding: 'utf8', timeout: 15_000,
      })
      expect(result.status, result.stderr + result.stdout).toBe(0)
      const actualPort = Number(readFileSync(join(dir, '.supremo/preview.port'), 'utf8'))
      const normal = await request(actualPort, 20)
      expect(normal.status).toBe(200)
      const info = JSON.parse(normal.body) as { limit: number; retained: boolean; nodeOptions: string }
      expect(info.limit).toBe(limit)
      expect(info.retained).toBe(true)
      expect(info.nodeOptions).toContain(originalOptions)
      expect(info.nodeOptions.match(/--max[-_]http[-_]header[-_]size/g) ?? []).toHaveLength(environment === 'production' ? 0 : 1)
      expect(existsSync(join(dir, '.supremo/preview-http/recovery.cjs'))).toBe(Boolean(recovery))
      // Reproduz o HTTP 431 real: o profile compartilhado enviava mais de 16 KiB.
      const sharedCookies = await request(actualPort, 18 * 1024)
      if (limit > 18 * 1024) expect(sharedCookies.status).toBe(200)
      else expect([0, 431]).toContain(sharedCookies.status)
      // Aumentar a capacidade do preview não remove o teto nem afeta produção.
      const excessive = await request(actualPort, 129 * 1024)
      if (recovery) {
        expect(excessive.status, readFileSync(join(dir, '.supremo/preview.log'), 'utf8')).toBe(307)
        expect([0, 431]).toContain((await request(actualPort, 129 * 1024)).status)
        expect((await request(actualPort, 80 * 1024)).status).toBe(200)
        expect(readFileSync(join(dir, '.supremo/preview.log'), 'utf8')).toContain('capacidade ajustada')
      } else {
        expect([0, 431]).toContain(excessive.status)
      }
      expect(process.env.NODE_OPTIONS).toBe(inheritedOptions)
    } finally {
      const pidPath = join(dir, '.supremo/preview.pid')
      if (existsSync(pidPath)) {
        const pid = Number(readFileSync(pidPath, 'utf8'))
        try { process.kill(-pid, 'SIGTERM') } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
        }
        spawnSync(process.execPath, ['scripts/preview.mjs', 'stop'], { cwd: dir, timeout: 5000 })
      }
      rmSync(dir, { recursive: true, force: true })
    }
  }, 20_000)

  it('Next real recupera navegação e continua editável no mesmo processo e porta', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'supremo-next-header-'))
    const port = await freePort()
    mkdirSync(join(dir, 'scripts'))
    mkdirSync(join(dir, 'app'))
    symlinkSync(resolve('node_modules'), join(dir, 'node_modules'), 'dir')
    writeFileSync(join(dir, 'scripts/preview.mjs'), previewSupervisorScript())
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'next dev --webpack --hostname 127.0.0.1' } }))
    writeFileSync(join(dir, 'app/layout.jsx'), 'export default function Layout({children}) { return <html><body>{children}</body></html> }')
    const page = join(dir, 'app/page.jsx')
    writeFileSync(page, 'export default function Page() { return <h1>Preview preservado</h1> }')
    const env: NodeJS.ProcessEnv = {
      ...process.env, NODE_ENV: 'development', NODE_OPTIONS: '', PORT: String(port), NEXT_TELEMETRY_DISABLED: '1',
      SUPREMO_PREVIEW_WAIT_INTERVAL_MS: '100', SUPREMO_PREVIEW_WAIT_TRIES: '200',
    }
    try {
      const started = spawnSync(process.execPath, ['scripts/preview.mjs', 'ensure'], {
        cwd: dir, env, encoding: 'utf8', timeout: 40_000,
      })
      expect(started.status, started.stdout + started.stderr).toBe(0)
      const actualPort = Number(readFileSync(join(dir, '.supremo/preview.port'), 'utf8'))
      const pid = readFileSync(join(dir, '.supremo/preview.pid'), 'utf8')
      expect((await request(actualPort, 80 * 1024)).status).toBe(307)
      const restored = await request(actualPort, 80 * 1024)
      expect(restored.status).toBe(200)
      expect(restored.body).toContain('Preview preservado')
      writeFileSync(page, 'export default function Page() { return <h1>Preview atualizado</h1> }')
      // O watcher recompila de forma assíncrona; a primeira resposta ainda
      // pode servir a versão anterior, sem representar perda de continuidade.
      await expect.poll(async () => {
        const edited = await request(actualPort, 80 * 1024)
        return edited.status === 200 && edited.body.includes('Preview atualizado')
      }, { timeout: 10_000, interval: 100 }).toBe(true)
      const reused = spawnSync(process.execPath, ['scripts/preview.mjs', 'ensure'], {
        cwd: dir, env, encoding: 'utf8', timeout: 10_000,
      })
      expect(reused.status, reused.stderr).toBe(0)
      expect(readFileSync(join(dir, '.supremo/preview.pid'), 'utf8')).toBe(pid)
      expect(Number(readFileSync(join(dir, '.supremo/preview.port'), 'utf8'))).toBe(actualPort)
    } finally {
      const pidPath = join(dir, '.supremo/preview.pid')
      if (existsSync(pidPath)) {
        try { process.kill(-Number(readFileSync(pidPath, 'utf8')), 'SIGTERM') } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
        }
        spawnSync(process.execPath, ['scripts/preview.mjs', 'stop'], { cwd: dir, timeout: 5000 })
      }
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
})
