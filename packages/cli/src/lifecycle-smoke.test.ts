import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

/**
 * SMOKE do LIFECYCLE real (v3.1 finalização, seção 13) — usa o BIN
 * EMPACOTADO (dist/bin.js, o mesmo publicado no npm), não funções unitárias
 * importadas. Simula o essencial de um bootstrap (workspace + project.json +
 * supervisor de preview + git) sem precisar de rede/backend/GitHub — e prova
 * exatamente a classe de regressão do E2E real: daemon/preview têm que ficar
 * de pé (persistentes, sobrevivendo a cada invocação separada da CLI, como
 * turnos diferentes do agente) e o checkpoint local nunca trava mesmo com o
 * backend inalcançável.
 *
 * O supervisor de preview usado aqui é um script REPRESENTATIVO (mesmo
 * padrão — detached/unref, pidfile, healthcheck HTTP, ensure/status/stop) —
 * não importado do gerador do template (evitaria acoplar a suíte de testes
 * deste pacote à árvore de módulos `@/...` do projeto raiz só por causa desta
 * referência cruzada). O TEXTO exato gerado para projetos reais já é validado
 * à exaustão em harness.test.ts e src/lib/templates/scaffold-smoke.test.ts —
 * aqui o alvo é o COMPORTAMENTO do padrão, não o texto literal do gerador.
 */
function fakePreviewSupervisorScript(): string {
  return `
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, rmSync, openSync } from 'node:fs'
import http from 'node:http'

const PORT = process.env.PORT || 3000
const PIDFILE = '.supremo-preview.pid'

function readPid() {
  try { return Number(readFileSync(PIDFILE, 'utf8').trim()) } catch { return null }
}
function alive(pid) {
  if (!pid) return false
  try { process.kill(pid, 0); return true } catch { return false }
}
function health() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/', timeout: 1000 }, (res) => {
      resolve(res.statusCode < 500); res.resume()
    })
    req.on('error', () => resolve(false))
    req.on('timeout', () => { req.destroy(); resolve(false) })
  })
}
async function ensure() {
  const pid = readPid()
  if (alive(pid) && (await health())) return
  const out = openSync('.supremo-preview.log', 'a')
  const child = spawn('npm', ['run', 'dev'], {
    detached: true, stdio: ['ignore', out, out], env: { ...process.env, PORT: String(PORT) },
  })
  child.unref()
  writeFileSync(PIDFILE, String(child.pid))
  for (let i = 0; i < 30; i++) {
    if (await health()) break
    await new Promise((r) => setTimeout(r, 300))
  }
}
async function status() {
  const pid = readPid()
  const up = alive(pid)
  console.log(JSON.stringify({ running: up, healthy: up && (await health()), pid: pid ?? null, port: PORT }))
}
function stop() {
  const pid = readPid()
  if (alive(pid)) { try { process.kill(pid) } catch {} }
  try { rmSync(PIDFILE) } catch {}
}
const cmd = process.argv[2] || 'ensure'
if (cmd === 'ensure') await ensure()
else if (cmd === 'status') await status()
else if (cmd === 'stop') stop()
`.trim()
}

const CLI_BIN = path.resolve(__dirname, '../dist/bin.js')

function cliAvailable(): boolean {
  return fs.existsSync(CLI_BIN)
}

describe('smoke — lifecycle real do CLI empacotado (preview + daemon + checkpoint)', () => {
  if (!cliAvailable()) {
    it.skip('packages/cli/dist/bin.js ausente — rode "npm run build" em packages/cli', () => {})
    return
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supremo-lifecycle-'))
  const projectId = `smoke-${crypto.randomBytes(6).toString('hex')}`
  // Porta ALEATÓRIA (não 3000): a máquina de dev pode ter outro processo
  // ocupando 3000 — foi exatamente isso que quebrou a primeira versão deste
  // teste (um dev server não relacionado já escutava lá).
  const PORT = 20000 + Math.floor(Math.random() * 20000)
  const previewEnv = { ...process.env, PORT: String(PORT) }

  afterAll(() => {
    try {
      execFileSync(process.execPath, [CLI_BIN, 'daemon', '--stop'], {
        cwd: dir,
        stdio: 'ignore',
        timeout: 5000,
      })
    } catch {
      // best-effort
    }
    try {
      execFileSync('node', ['scripts/preview.mjs', 'stop'], {
        cwd: dir,
        stdio: 'ignore',
        timeout: 5000,
      })
    } catch {
      // best-effort
    }
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('monta um workspace mínimo: .supremo/project.json + supervisor de preview REAL + git', () => {
    fs.mkdirSync(path.join(dir, '.supremo'), { recursive: true })
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true })

    // supremoUrl aponta pra uma porta local morta de propósito — o daemon
    // precisa sobreviver e continuar rodando mesmo sem NUNCA conseguir falar
    // com o backend (offline-first, seção 6).
    fs.writeFileSync(
      path.join(dir, '.supremo/project.json'),
      JSON.stringify({
        projectId,
        supremoUrl: 'http://127.0.0.1:1',
        scaffoldVersion: '3.3.0',
        securityBaselineVersion: '2.0.0',
        securityProfile: 'simple',
        capabilities: [],
      }),
    )

    // "dev server" mínimo (não é o Next.js real — só precisa responder HTTP
    // na porta certa para o supervisor de preview considerar saudável; o
    // MECANISMO do supervisor — detached, pidfile, healthcheck — é o mesmo).
    fs.writeFileSync(
      path.join(dir, 'scripts/fake-dev-server.mjs'),
      "import http from 'node:http'\n" +
        'const port = process.env.PORT || 3000\n' +
        "http.createServer((_, res) => res.end('ok')).listen(port)\n",
    )
    fs.writeFileSync(path.join(dir, 'scripts/preview.mjs'), fakePreviewSupervisorScript())
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'smoke', scripts: { dev: 'node scripts/fake-dev-server.mjs' } }),
    )

    execFileSync('git', ['init', '-q'], { cwd: dir })
    execFileSync('git', ['config', 'user.email', 'smoke@supremo.test'], { cwd: dir })
    execFileSync('git', ['config', 'user.name', 'Supremo Smoke'], { cwd: dir })
    fs.writeFileSync(path.join(dir, 'README.md'), '# smoke\n')
    execFileSync('git', ['add', '-A'], { cwd: dir })
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir })

    expect(fs.existsSync(path.join(dir, 'scripts/preview.mjs'))).toBe(true)
  })

  it(
    'preview:ensure sobe de verdade e preview:status confirma running+healthy',
    () => {
      execFileSync('node', ['scripts/preview.mjs', 'ensure'], {
        cwd: dir,
        env: previewEnv,
        stdio: 'ignore',
        timeout: 15_000,
      })
      const status = JSON.parse(
        execFileSync('node', ['scripts/preview.mjs', 'status'], {
          cwd: dir,
          env: previewEnv,
          encoding: 'utf8',
          timeout: 10_000,
        }),
      ) as { running: boolean; healthy: boolean }
      expect(status.running).toBe(true)
      expect(status.healthy).toBe(true)
    },
    20_000,
  )

  it(
    'daemon:ensure sobe de verdade (mesmo com backend INALCANÇÁVEL) e daemon:status confirma running',
    () => {
      execFileSync(process.execPath, [CLI_BIN, 'daemon', '--ensure'], {
        cwd: dir,
        stdio: 'ignore',
        timeout: 10_000,
      })
      const status = JSON.parse(
        execFileSync(process.execPath, [CLI_BIN, 'daemon', '--status'], {
          cwd: dir,
          encoding: 'utf8',
          timeout: 10_000,
        }),
      ) as { running: boolean; pid: number | null }
      expect(status.running).toBe(true)
      expect(status.pid).not.toBeNull()
    },
    15_000,
  )

  it(
    'checkpoint LOCAL funciona OFFLINE (backend inalcançável) — nunca trava, retorna rápido',
    () => {
      fs.writeFileSync(path.join(dir, 'README.md'), '# smoke changed\n')
      const start = Date.now()
      const out = execFileSync(process.execPath, [CLI_BIN, 'checkpoint', 'teste offline'], {
        cwd: dir,
        encoding: 'utf8',
        timeout: 10_000, // se travasse esperando rede, isto estouraria
      })
      const elapsedMs = Date.now() - start
      expect(out).toContain('checkpoint')
      // checkpoint é 100% local — não deveria nem chegar perto do timeout.
      expect(elapsedMs).toBeLessThan(8_000)
    },
    15_000,
  )

  it(
    'preview e daemon CONTINUAM vivos depois do checkpoint (persistentes entre "turnos" simulados)',
    () => {
      const previewStatus = JSON.parse(
        execFileSync('node', ['scripts/preview.mjs', 'status'], {
          cwd: dir,
          env: previewEnv,
          encoding: 'utf8',
          timeout: 10_000,
        }),
      ) as { running: boolean; healthy: boolean }
      const daemonStatus = JSON.parse(
        execFileSync(process.execPath, [CLI_BIN, 'daemon', '--status'], {
          cwd: dir,
          encoding: 'utf8',
          timeout: 10_000,
        }),
      ) as { running: boolean }
      expect(previewStatus.running).toBe(true)
      expect(previewStatus.healthy).toBe(true)
      expect(daemonStatus.running).toBe(true)
    },
    15_000,
  )

  it(
    'daemon:ensure de novo é IDEMPOTENTE — reusa a mesma instância (não duplica)',
    () => {
      const before = JSON.parse(
        execFileSync(process.execPath, [CLI_BIN, 'daemon', '--status'], {
          cwd: dir,
          encoding: 'utf8',
          timeout: 10_000,
        }),
      ) as { pid: number | null }
      execFileSync(process.execPath, [CLI_BIN, 'daemon', '--ensure'], {
        cwd: dir,
        stdio: 'ignore',
        timeout: 10_000,
      })
      const after = JSON.parse(
        execFileSync(process.execPath, [CLI_BIN, 'daemon', '--status'], {
          cwd: dir,
          encoding: 'utf8',
          timeout: 10_000,
        }),
      ) as { pid: number | null }
      expect(after.pid).toBe(before.pid) // mesmo processo, não um novo
    },
    15_000,
  )
})
