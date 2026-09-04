import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { previewSupervisorScript, supremoStatusScript } from './harness'

/**
 * Preflight local de retomada (v3.4, ex-"retomada automática de sessão"
 * v3.2) — E2E REAL. `npm run supremo:resume` (= `node scripts/supremo-status
 * .mjs --ensure`) agora roda ANTES DE TODO pedido que muda código — não só
 * "no primeiro da sessão" (a antiga regra: o host pode restaurar a MESMA
 * conversa depois de fechar/reabrir sem nenhum sinal de reinício — E2E real,
 * teste-v3-12 — então não dá pra confiar em detectar "sessão nova"). Isso só
 * é seguro porque a checagem é 100% LOCAL. Executa o script REAL gerado
 * (`supremoStatusScript()`) contra um preview REAL (`previewSupervisorScript
 * ()`, mesmo padrão de `preview-ownership.test.ts`) e um daemon SIMULADO —
 * um shim de `npx` que sobe/derruba um processo Node de verdade (pid
 * sinalizável de verdade), escrevendo no MESMO pidfile que o daemon real usa
 * (`packages/cli/src/daemon.ts#DAEMON_PID_FILE`) — pra reproduzir "reboot: o
 * arquivo de estado sobrevive, o processo não" sem depender da CLI publicada
 * nem de rede.
 *
 * O shim só reconhece `daemon --ensure` — nem `daemon --status` (o status
 * agora é lido LOCAL, direto do pidfile, nunca por `npx`) nem qualquer outra
 * coisa (inclusive `bootstrap`) — qualquer chamada fora disso é INESPERADA,
 * registrada num log — prova de que a checagem nunca toca rede no caminho
 * saudável e nunca acopla bootstrap.
 */

const DAEMON_PID_FILE_REL = '.supremo/checkpoints/daemon.pid'

function daemonShim(): string {
  return `#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

const args = process.argv.slice(2)
fs.appendFileSync(process.env.RESUME_TEST_CALL_LOG, JSON.stringify(args) + '\\n')

// MESMO local que o daemon real usa (packages/cli/src/daemon.ts#DAEMON_PID_FILE)
// — supremo-status.mjs (v3.4) lê esse arquivo DIRETO pro status, sem passar
// por este shim; o shim só existe pro --ensure (religar de verdade).
const PID_FILE = '${DAEMON_PID_FILE_REL}'

function alive(pid) {
  if (!pid) return false
  try { process.kill(pid, 0); return true } catch { return false }
}
function readPid() {
  try {
    const pid = Number(fs.readFileSync(PID_FILE, 'utf8').trim())
    return Number.isFinite(pid) && pid > 0 ? pid : null
  } catch { return null }
}

const isDaemonCmd = args[0] === '--yes' && args[1] === 'supremo-cli' && args[2] === 'daemon'
if (!isDaemonCmd) {
  console.error('chamada inesperada: ' + JSON.stringify(args))
  process.exit(1)
}

if (args.includes('--ensure')) {
  const pid = readPid()
  if (!alive(pid)) {
    fs.mkdirSync(path.dirname(PID_FILE), { recursive: true })
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: 'ignore',
    })
    child.unref()
    fs.writeFileSync(PID_FILE, String(child.pid))
  }
} else {
  console.error('chamada inesperada (sem --ensure — status agora é local, nunca por npx): ' + JSON.stringify(args))
  process.exit(1)
}
`
}

interface ResumeJson {
  preview: { running: boolean; healthy: boolean; url: string | null }
  daemon: { running: boolean; healthy: boolean }
  checkpoints: { pending: number }
}

/** Lê o MESMO pidfile local que supremo-status.mjs (v3.4) e o daemon real usam. */
function daemonState(dir: string): { pid: number | null } {
  try {
    const pid = Number(readFileSync(join(dir, DAEMON_PID_FILE_REL), 'utf8').trim())
    return { pid: Number.isFinite(pid) && pid > 0 ? pid : null }
  } catch {
    return { pid: null }
  }
}

function callLog(dir: string): string[][] {
  try {
    return readFileSync(join(dir, 'npx-call-log.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as string[])
  } catch {
    return []
  }
}

function alivePid(pid: number | null): boolean {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Sleep SÍNCRONO (o teste não é async) — só pra dar tempo do SIGKILL surtir efeito. */
function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** SIGKILL (morte imediata, sem graceful shutdown — mais fiel a um "reboot" real) + espera confirmar. */
function killAndWait(pid: number, timeoutMs = 3000): void {
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    /* já morto */
  }
  const start = Date.now()
  while (alivePid(pid) && Date.now() - start < timeoutMs) {
    sleepMs(50)
  }
}

describe('supremo:resume (supremo-status.mjs --ensure) — retomada automática de sessão real (v3.2)', () => {
  let dir: string

  afterEach(() => {
    // Nunca deixa processo órfão pra trás — mata o que a fixture subiu.
    const { pid } = daemonState(dir)
    if (pid) {
      try {
        process.kill(pid)
      } catch {
        /* já morto */
      }
    }
    try {
      const previewPid = Number(readFileSync(join(dir, '.supremo/preview.pid'), 'utf8').trim())
      if (previewPid) process.kill(previewPid)
    } catch {
      /* já morto/nunca subiu */
    }
    rmSync(dir, { recursive: true, force: true })
  })

  function setup(port: number): { dir: string; env: NodeJS.ProcessEnv } {
    dir = mkdtempSync(join(tmpdir(), 'supremo-resume-'))
    const binDir = join(dir, 'bin')
    mkdirSync(binDir, { recursive: true })
    mkdirSync(join(dir, 'scripts'), { recursive: true })

    writeFileSync(join(dir, 'scripts/preview.mjs'), previewSupervisorScript(), 'utf8')
    writeFileSync(join(dir, 'scripts/supremo-status.mjs'), supremoStatusScript(), 'utf8')
    writeFileSync(
      join(dir, 'scripts/dev-server.mjs'),
      "import http from 'node:http'\n" +
        'const port = Number(process.env.PORT || 3000)\n' +
        "http.createServer((_, res) => res.end('ok')).listen(port, '127.0.0.1')\n",
      'utf8',
    )
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'resume-fixture', scripts: { dev: 'node scripts/dev-server.mjs' } }),
    )
    const shimPath = join(binDir, 'npx')
    writeFileSync(shimPath, daemonShim(), { mode: 0o755 })

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      PORT: String(port),
      RESUME_TEST_CALL_LOG: join(dir, 'npx-call-log.jsonl'),
    }
    return { dir, env }
  }

  function runResume(env: NodeJS.ProcessEnv, args: string[] = ['--ensure']): ResumeJson {
    const out = execFileSync(process.execPath, [join(dir, 'scripts/supremo-status.mjs'), ...args], {
      cwd: dir,
      env,
      encoding: 'utf8',
      timeout: 20_000,
    })
    return JSON.parse(out) as ResumeJson
  }

  it(
    'daemon e preview JÁ VIVOS → resume só reutiliza (mesmos pids, nenhum restart) — item 1',
    () => {
      const port = 21000 + Math.floor(Math.random() * 4000)
      const { env } = setup(port)

      // Sobe os dois de propósito ANTES do resume (equivalente ao primeiro
      // pedido de uma sessão anterior já ter deixado tudo de pé).
      execFileSync(process.execPath, [join(dir, 'scripts/preview.mjs'), 'ensure'], {
        cwd: dir,
        env,
        stdio: 'ignore',
        timeout: 15_000,
      })
      execFileSync(join(dir, 'bin/npx'), ['--yes', 'supremo-cli', 'daemon', '--ensure'], {
        cwd: dir,
        env,
        stdio: 'ignore',
      })
      const previewPidBefore = Number(readFileSync(join(dir, '.supremo/preview.pid'), 'utf8').trim())
      const daemonPidBefore = daemonState(dir).pid

      const result = runResume(env)

      expect(result.preview.healthy).toBe(true)
      expect(result.daemon.healthy).toBe(true)
      expect(result.preview.url).toBe(`http://localhost:${port}`)

      const previewPidAfter = Number(readFileSync(join(dir, '.supremo/preview.pid'), 'utf8').trim())
      const daemonPidAfter = daemonState(dir).pid
      expect(previewPidAfter).toBe(previewPidBefore) // mesmo processo — nunca reiniciado
      expect(daemonPidAfter).toBe(daemonPidBefore)
    },
    30_000,
  )

  it(
    'reboot simulado: processos MORTOS mas .supremo/estado persistido → resume religa os dois sozinho — itens 2 e 5',
    () => {
      const port = 21000 + Math.floor(Math.random() * 4000)
      const { env } = setup(port)

      execFileSync(process.execPath, [join(dir, 'scripts/preview.mjs'), 'ensure'], {
        cwd: dir,
        env,
        stdio: 'ignore',
        timeout: 15_000,
      })
      execFileSync(join(dir, 'bin/npx'), ['--yes', 'supremo-cli', 'daemon', '--ensure'], {
        cwd: dir,
        env,
        stdio: 'ignore',
      })
      const previewPidBefore = Number(readFileSync(join(dir, '.supremo/preview.pid'), 'utf8').trim())
      const daemonPidBefore = daemonState(dir).pid!

      // "Reboot": mata os processos de verdade, mas NUNCA apaga
      // .supremo/preview.pid|.port nem o estado do daemon — exatamente o que
      // sobrevive a um reinício de máquina.
      killAndWait(previewPidBefore)
      killAndWait(daemonPidBefore)
      expect(alivePid(previewPidBefore)).toBe(false)
      expect(alivePid(daemonPidBefore)).toBe(false)
      expect(existsSync(join(dir, '.supremo/preview.pid'))).toBe(true)
      expect(existsSync(join(dir, '.supremo/preview.port'))).toBe(true)

      const result = runResume(env)

      expect(result.preview.healthy).toBe(true)
      expect(result.daemon.healthy).toBe(true)

      const previewPidAfter = Number(readFileSync(join(dir, '.supremo/preview.pid'), 'utf8').trim())
      const daemonPidAfter = daemonState(dir).pid
      expect(previewPidAfter).not.toBe(previewPidBefore) // processo NOVO, religado
      expect(daemonPidAfter).not.toBe(daemonPidBefore)
      expect(alivePid(previewPidAfter)).toBe(true)
      expect(alivePid(daemonPidAfter)).toBe(true)

      // Nunca invocou bootstrap nem nenhum outro comando — só --status/--ensure.
      for (const call of callLog(dir)) {
        expect(call).not.toContain('bootstrap')
      }
    },
    30_000,
  )

  it(
    'preview saudável numa porta alternativa persistida (não 3000) → resume reutiliza EXATAMENTE aquela porta — item 3',
    () => {
      const altPort = 27777 // bem longe de 3000, prova que não é coincidência
      const { env } = setup(altPort)
      execFileSync(process.execPath, [join(dir, 'scripts/preview.mjs'), 'ensure'], {
        cwd: dir,
        env,
        stdio: 'ignore',
        timeout: 15_000,
      })
      execFileSync(join(dir, 'bin/npx'), ['--yes', 'supremo-cli', 'daemon', '--ensure'], {
        cwd: dir,
        env,
        stdio: 'ignore',
      })
      const persistedPort = Number(readFileSync(join(dir, '.supremo/preview.port'), 'utf8').trim())
      expect(persistedPort).toBe(altPort)

      const result = runResume(env)

      expect(result.preview.url).toBe(`http://localhost:${altPort}`)
      expect(result.preview.healthy).toBe(true)
    },
    30_000,
  )

  it(
    '.supremo/preview.port existe mas o servidor morreu → NUNCA finge saudável antes do ensure — item 4',
    () => {
      const port = 21000 + Math.floor(Math.random() * 4000)
      const { env } = setup(port)
      mkdirSync(join(dir, '.supremo'), { recursive: true })
      // pid de um processo que comprovadamente NÃO existe (nunca foi criado
      // por este teste) — simula o rastro morto sem nunca ter subido nada.
      const deadPid = 999_999
      writeFileSync(join(dir, '.supremo/preview.pid'), String(deadPid))
      writeFileSync(join(dir, '.supremo/preview.port'), String(port))

      // Checagem direta (sem --ensure): status nunca finge saudável só
      // porque o arquivo existe.
      const statusOnly = JSON.parse(
        execFileSync(process.execPath, [join(dir, 'scripts/preview.mjs'), 'status'], {
          cwd: dir,
          env,
          encoding: 'utf8',
          timeout: 10_000,
        }),
      ) as { running: boolean; healthy: boolean }
      expect(statusOnly.healthy).toBe(false)

      // resume então religa de verdade.
      const result = runResume(env)
      expect(result.preview.healthy).toBe(true)
    },
    30_000,
  )

  it(
    'nada registrado (nem preview, nem daemon) → resume sobe os dois pelo fallback normal, sem bootstrap — item 6',
    () => {
      const port = 21000 + Math.floor(Math.random() * 4000)
      const { env } = setup(port)
      expect(existsSync(join(dir, '.supremo'))).toBe(false)

      const result = runResume(env)

      expect(result.preview.healthy).toBe(true)
      expect(result.daemon.healthy).toBe(true)
      for (const call of callLog(dir)) {
        expect(call).not.toContain('bootstrap')
      }
    },
    30_000,
  )

  it(
    'já saudável → resume não gasta o ensure (idempotente) e retorna RÁPIDO — item 8 (nenhuma checagem pesada)',
    () => {
      const port = 21000 + Math.floor(Math.random() * 4000)
      const { env } = setup(port)
      execFileSync(process.execPath, [join(dir, 'scripts/preview.mjs'), 'ensure'], {
        cwd: dir,
        env,
        stdio: 'ignore',
        timeout: 15_000,
      })
      execFileSync(join(dir, 'bin/npx'), ['--yes', 'supremo-cli', 'daemon', '--ensure'], {
        cwd: dir,
        env,
        stdio: 'ignore',
      })

      const start = Date.now()
      const result = runResume(env)
      const elapsedMs = Date.now() - start

      expect(result.preview.healthy).toBe(true)
      expect(result.daemon.healthy).toBe(true)
      // Nada de build/suíte/install: já saudável, resume é só 2 checagens
      // rápidas — nunca deveria chegar perto de segundos de verdade.
      expect(elapsedMs).toBeLessThan(5_000)
    },
    30_000,
  )
})

/**
 * Retry único quando a 1ª tentativa de `ensure` do preview falha (v3.4.1,
 * teste-v3-13) — E2E REAL sobre um `scripts/preview.mjs` SIMULADO (não o
 * supervisor real): a 1ª chamada de `ensure` falha de propósito (não deixa
 * nada saudável — mesmo sintoma do E2E real: corrida de porta/processo que
 * ainda não soltou o bind), e só a 2ª sobe um servidor de verdade. Simular
 * (em vez de derrubar o supervisor real) é o único jeito de forçar a
 * PRIMEIRA tentativa a falhar de forma determinística sem depender de
 * timing de rede real entre as duas chamadas, que `supremo-status.mjs`
 * faz de dentro do MESMO processo, sem nenhum ponto de controle do teste
 * entre elas — mesma técnica já usada aqui pro daemon (`daemonShim()`).
 *
 * O daemon já está saudável ANTES do resume (pré-aquecido, mesmo padrão dos
 * testes acima) — isola o teste no retry do PREVIEW especificamente, sem
 * envolver o caminho do daemon.
 */
describe('supremo:resume — retry único quando a 1ª tentativa do preview falha (v3.4.1, teste-v3-13)', () => {
  let dir: string

  afterEach(() => {
    const daemonPid = daemonState(dir).pid
    if (daemonPid) {
      try {
        process.kill(daemonPid)
      } catch {
        /* já morto */
      }
    }
    try {
      const previewPid = Number(readFileSync(join(dir, '.supremo/preview.pid'), 'utf8').trim())
      if (previewPid) process.kill(previewPid)
    } catch {
      /* já morto/nunca subiu */
    }
    rmSync(dir, { recursive: true, force: true })
  })

  /**
   * `succeedFromCall`: a partir de qual chamada de `ensure` o shim sobe um
   * servidor de verdade (1 = sempre sucesso; 2 = falha só na 1ª; um número
   * maior que o total esperado de chamadas = falha SEMPRE).
   */
  function flakyPreviewShim(succeedFromCall: number): string {
    return `#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'

const PID_FILE = '.supremo/preview.pid'
const PORT_FILE = '.supremo/preview.port'
const PORT = Number(process.env.PORT || 3000)

function bumpCount() {
  let n = 0
  try { n = Number(fs.readFileSync(process.env.PREVIEW_ENSURE_CALL_LOG, 'utf8').trim()) } catch {}
  n += 1
  fs.writeFileSync(process.env.PREVIEW_ENSURE_CALL_LOG, String(n))
  return n
}
function alive(pid) {
  if (!pid) return false
  try { process.kill(pid, 0); return true } catch { return false }
}
function readState() {
  let pid = null, port = null
  try { pid = Number(fs.readFileSync(PID_FILE, 'utf8').trim()) } catch {}
  try { port = Number(fs.readFileSync(PORT_FILE, 'utf8').trim()) } catch {}
  return { pid: Number.isFinite(pid) && pid > 0 ? pid : null, port: Number.isFinite(port) ? port : null }
}
function waitReady(timeoutMs) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve) => {
    const tryOnce = () => {
      const req = http.get({ host: '127.0.0.1', port: PORT, timeout: 300 }, (res) => { res.resume(); resolve(true) })
      req.on('error', () => { if (Date.now() < deadline) setTimeout(tryOnce, 50); else resolve(false) })
      req.on('timeout', () => { req.destroy() })
    }
    tryOnce()
  })
}

const cmd = process.argv[2]

if (cmd === 'ensure') {
  const count = bumpCount()
  if (count < ${succeedFromCall}) {
    // Falha DE PROPÓSITO (mesmo sintoma do E2E real: corrida de porta) —
    // não escreve pid/port nenhum, sai OK (best-effort — run() do
    // supremo-status.mjs ignora exit code mesmo).
    process.exit(0)
  }
  fs.mkdirSync(path.dirname(PID_FILE), { recursive: true })
  const child = spawn(
    process.execPath,
    ['-e', \`require('http').createServer((_, res) => res.end('ok')).listen(\${PORT}, '127.0.0.1')\`],
    { detached: true, stdio: 'ignore' },
  )
  child.unref()
  const ready = await waitReady(5000)
  if (ready) {
    fs.writeFileSync(PID_FILE, String(child.pid))
    fs.writeFileSync(PORT_FILE, String(PORT))
  }
}

if (cmd === 'status') {
  const { pid, port } = readState()
  const running = alive(pid)
  console.log(JSON.stringify({ running, healthy: running, url: running ? \`http://localhost:\${port}\` : null }))
}
`
  }

  function setup(port: number, succeedFromCall: number): { env: NodeJS.ProcessEnv; callLogFile: string } {
    dir = mkdtempSync(join(tmpdir(), 'supremo-resume-retry-'))
    const binDir = join(dir, 'bin')
    mkdirSync(binDir, { recursive: true })
    mkdirSync(join(dir, 'scripts'), { recursive: true })

    writeFileSync(join(dir, 'scripts/preview.mjs'), flakyPreviewShim(succeedFromCall), 'utf8')
    writeFileSync(join(dir, 'scripts/supremo-status.mjs'), supremoStatusScript(), 'utf8')
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'resume-retry-fixture', scripts: {} }))
    writeFileSync(join(binDir, 'npx'), daemonShim(), { mode: 0o755 })

    const callLogFile = join(dir, 'preview-ensure-call-count.txt')
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      PORT: String(port),
      RESUME_TEST_CALL_LOG: join(dir, 'npx-call-log.jsonl'),
      PREVIEW_ENSURE_CALL_LOG: callLogFile,
    }
    return { env, callLogFile }
  }

  function runResume(env: NodeJS.ProcessEnv): { status: number; result: ResumeJson | null; stdout: string } {
    try {
      const out = execFileSync(process.execPath, [join(dir, 'scripts/supremo-status.mjs'), '--ensure'], {
        cwd: dir,
        env,
        encoding: 'utf8',
        timeout: 20_000,
      })
      return { status: 0, result: JSON.parse(out) as ResumeJson, stdout: out }
    } catch (err) {
      const e = err as { status: number | null; stdout: string }
      return { status: e.status ?? 1, result: e.stdout ? (JSON.parse(e.stdout) as ResumeJson) : null, stdout: e.stdout }
    }
  }

  function preWarmDaemon(env: NodeJS.ProcessEnv): void {
    execFileSync(join(dir, 'bin/npx'), ['--yes', 'supremo-cli', 'daemon', '--ensure'], {
      cwd: dir,
      env,
      stdio: 'ignore',
    })
  }

  it(
    '1) 1ª tentativa do ensure falha → 2) retry único recupera → 3) healthy vira true → 4) só então o resultado libera o trabalho',
    () => {
      const port = 21000 + Math.floor(Math.random() * 4000)
      // Sucede só a partir da 2ª chamada — a 1ª está garantida a falhar.
      const { env, callLogFile } = setup(port, 2)
      preWarmDaemon(env)

      const { status, result } = runResume(env)

      expect(status).toBe(0)
      expect(result?.preview.healthy).toBe(true)
      expect(result?.daemon.healthy).toBe(true)
      expect(result?.preview.url).toBe(`http://localhost:${port}`)
      // Exatamente 2 chamadas: a 1ª (falhou) + UMA única recuperação —
      // nunca um loop, nunca uma 3ª tentativa.
      expect(readFileSync(callLogFile, 'utf8').trim()).toBe('2')
    },
    30_000,
  )

  it(
    'retry TAMBÉM falha → supremo:resume sai com código de erro, preview.healthy fica false, NUNCA uma 3ª tentativa',
    () => {
      const port = 21000 + Math.floor(Math.random() * 4000)
      // succeedFromCall bem maior que o total de chamadas esperado (2):
      // toda tentativa falha, sempre.
      const { env, callLogFile } = setup(port, 99)
      preWarmDaemon(env)

      const { status, result } = runResume(env)

      expect(status).not.toBe(0)
      expect(result?.preview.healthy).toBe(false)
      // Mesmo com o preview morto, o daemon (pré-aquecido) segue saudável —
      // prova que o retry/gate é por sinal PRÓPRIO de cada um, não os dois
      // juntos escondendo qual falhou.
      expect(result?.daemon.healthy).toBe(true)
      // Exatamente 2 chamadas — a 1ª + a única recuperação permitida.
      // NUNCA um loop tentando de novo indefinidamente.
      expect(readFileSync(callLogFile, 'utf8').trim()).toBe('2')
    },
    30_000,
  )
})
