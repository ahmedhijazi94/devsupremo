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
 * um shim que sobe/derruba um processo Node de verdade (pid sinalizável de
 * verdade), escrevendo no MESMO pidfile que o daemon real usa
 * (`packages/cli/src/daemon.ts#DAEMON_PID_FILE`) — pra reproduzir "reboot: o
 * arquivo de estado sobrevive, o processo não" sem depender da CLI publicada
 * nem de rede.
 *
 * (v3.4.4, teste-v3-15) O shim agora vive em `node_modules/.bin/supremo` — o
 * MESMO caminho que `--ensure` resolve local (supremo-cli é devDependency
 * PINADA do scaffold; ver LOCAL_SUPREMO_CLI_BIN em harness.ts), nunca mais um
 * shim de `npx` no PATH. O shim só reconhece `daemon --ensure` — qualquer
 * outra coisa (inclusive `bootstrap`) é INESPERADA, registrada num log —
 * prova de que a checagem nunca toca rede/npx no caminho saudável nem ao
 * religar, e nunca acopla bootstrap.
 */

const DAEMON_PID_FILE_REL = '.supremo/checkpoints/daemon.pid'
const LOCAL_SUPREMO_CLI_BIN_REL = 'node_modules/.bin/supremo'

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

// Invocado DIRETO como node_modules/.bin/supremo (v3.4.4) — só 'daemon --ensure'.
if (args[0] !== 'daemon' || !args.includes('--ensure')) {
  console.error('chamada inesperada: ' + JSON.stringify(args))
  process.exit(1)
}

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
`
}

/** Instala o shim em `node_modules/.bin/supremo` (v3.4.4) — o MESMO caminho
 * que `--ensure` resolve local, nunca mais um shim de `npx` no PATH. */
function installLocalSupremoCliShim(dir: string): void {
  const binDir = join(dir, 'node_modules/.bin')
  mkdirSync(binDir, { recursive: true })
  writeFileSync(join(binDir, 'supremo'), daemonShim(), { mode: 0o755 })
}

interface ResumeJson {
  preview: { running: boolean; healthy: boolean; url: string | null }
  daemon: { running: boolean; healthy: boolean; error?: string }
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
    installLocalSupremoCliShim(dir)

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PORT: String(port),
      RESUME_TEST_CALL_LOG: join(dir, 'npx-call-log.jsonl'),
      // ensure() do supervisor real já espera internamente (waitReady) até o
      // dev-server.mjs (HTTP puro, sobe quase instantâneo) responder — a
      // janela de polling do preflight abaixo não é o que estes testes
      // cobrem; encurtada só pra não gastar os 4s de produção à toa.
      SUPREMO_PREFLIGHT_POLL_INTERVAL_MS: '20',
      SUPREMO_PREFLIGHT_POLL_TIMEOUT_MS: '2000',
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
      execFileSync(join(dir, LOCAL_SUPREMO_CLI_BIN_REL), ['daemon', '--ensure'], {
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
      execFileSync(join(dir, LOCAL_SUPREMO_CLI_BIN_REL), ['daemon', '--ensure'], {
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
      execFileSync(join(dir, LOCAL_SUPREMO_CLI_BIN_REL), ['daemon', '--ensure'], {
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
      execFileSync(join(dir, LOCAL_SUPREMO_CLI_BIN_REL), ['daemon', '--ensure'], {
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
    mkdirSync(join(dir, 'scripts'), { recursive: true })

    writeFileSync(join(dir, 'scripts/preview.mjs'), flakyPreviewShim(succeedFromCall), 'utf8')
    writeFileSync(join(dir, 'scripts/supremo-status.mjs'), supremoStatusScript(), 'utf8')
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'resume-retry-fixture', scripts: {} }))
    installLocalSupremoCliShim(dir)

    const callLogFile = join(dir, 'preview-ensure-call-count.txt')
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PORT: String(port),
      RESUME_TEST_CALL_LOG: join(dir, 'npx-call-log.jsonl'),
      PREVIEW_ENSURE_CALL_LOG: callLogFile,
      // O shim decide healthy por CONTAGEM de chamada, não por tempo — a
      // janela de polling do preflight não muda o resultado aqui, só quanto
      // tempo o teste espera até desistir. Encurtada só pra não gastar os
      // 4s de produção à toa quando a resposta já é definitiva na 1ª leitura.
      SUPREMO_PREFLIGHT_POLL_INTERVAL_MS: '20',
      SUPREMO_PREFLIGHT_POLL_TIMEOUT_MS: '100',
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
    execFileSync(join(dir, LOCAL_SUPREMO_CLI_BIN_REL), ['daemon', '--ensure'], {
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

/**
 * Janela curta de polling depois do ensure (v3.4.2, teste-v3-14) — E2E REAL.
 * Cenário observado: `supremo:resume` religava o preview corretamente — o
 * processo ficava `running=true` na hora — mas o Next ainda estava
 * compilando a 1ª rota, então `healthy=false` por alguns segundos. Uma ÚNICA
 * leitura de status logo depois do `ensure` (o que o preflight fazia antes
 * do v3.4.1) é uma corrida: o preflight abortava cedo demais, e o MESMO
 * comando, rodado poucos segundos depois sem nenhuma intervenção, já
 * mostrava `healthy=true`. Não é falha de restart — é corrida de timing.
 *
 * Este shim reproduz o sintoma exato: `ensure` grava pid/porta e sobe um
 * processo real IMEDIATAMENTE (`running=true` na hora), mas o servidor HTTP
 * só começa a escutar depois de `HEALTH_DELAY_MS` (simula o Next
 * compilando) — `healthy` só vira `true` quando o probe HTTP de verdade
 * (mesmo `health()` do supervisor real) alcançar a porta já escutando.
 */
describe('supremo:resume — janela curta de polling depois do ensure (v3.4.2, teste-v3-14)', () => {
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

  function slowToHealthyPreviewShim(): string {
    return `#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'

const PID_FILE = '.supremo/preview.pid'
const PORT_FILE = '.supremo/preview.port'
const PORT = Number(process.env.PORT || 3000)
const DELAY_MS = Number(process.env.HEALTH_DELAY_MS || 800)

function alive(pid) {
  if (!pid) return false
  try { process.kill(pid, 0); return true } catch { return false }
}
function readState() {
  let pid = null
  try { pid = Number(fs.readFileSync(PID_FILE, 'utf8').trim()) } catch {}
  return { pid: Number.isFinite(pid) && pid > 0 ? pid : null }
}
function health(port, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: timeoutMs }, (res) => { res.resume(); resolve((res.statusCode || 0) > 0) })
    req.on('error', () => resolve(false))
    req.on('timeout', () => { req.destroy(); resolve(false) })
  })
}

const cmd = process.argv[2]

if (cmd === 'ensure') {
  let n = 0
  try { n = Number(fs.readFileSync(process.env.PREVIEW_ENSURE_CALL_LOG, 'utf8').trim()) } catch {}
  fs.writeFileSync(process.env.PREVIEW_ENSURE_CALL_LOG, String(n + 1))

  fs.mkdirSync(path.dirname(PID_FILE), { recursive: true })
  // Processo real sobe NA HORA (running=true imediato) — só o LISTEN do
  // servidor HTTP é adiado, exatamente o sintoma do E2E real (Next ainda
  // compilando a 1ª rota: o processo já existe, a porta ainda não responde).
  const child = spawn(
    process.execPath,
    ['-e', \`setTimeout(() => { require('http').createServer((_, res) => res.end('ok')).listen(\${PORT}, '127.0.0.1') }, \${DELAY_MS})\`],
    { detached: true, stdio: 'ignore' },
  )
  child.unref()
  fs.writeFileSync(PID_FILE, String(child.pid))
  fs.writeFileSync(PORT_FILE, String(PORT))
}

if (cmd === 'status') {
  const { pid } = readState()
  const running = alive(pid)
  const healthy = running && (await health(PORT, 1500))
  console.log(JSON.stringify({ running, healthy, url: healthy ? \`http://localhost:\${PORT}\` : null }))
}
`
  }

  function setup(
    port: number,
    healthDelayMs: number,
  ): { env: NodeJS.ProcessEnv; callLogFile: string } {
    dir = mkdtempSync(join(tmpdir(), 'supremo-resume-timing-'))
    mkdirSync(join(dir, 'scripts'), { recursive: true })

    writeFileSync(join(dir, 'scripts/preview.mjs'), slowToHealthyPreviewShim(), 'utf8')
    writeFileSync(join(dir, 'scripts/supremo-status.mjs'), supremoStatusScript(), 'utf8')
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'resume-timing-fixture', scripts: {} }))
    installLocalSupremoCliShim(dir)

    const callLogFile = join(dir, 'preview-ensure-call-count.txt')
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PORT: String(port),
      RESUME_TEST_CALL_LOG: join(dir, 'npx-call-log.jsonl'),
      PREVIEW_ENSURE_CALL_LOG: callLogFile,
      HEALTH_DELAY_MS: String(healthDelayMs),
      // Janela de polling real (não instantânea) — precisa ser MAIOR que
      // healthDelayMs pra dar tempo do servidor terminar de subir, e o
      // intervalo precisa ser menor que a folga entre eles pra provar que é
      // um POLLING (várias leituras), não uma segunda leitura só por sorte.
      SUPREMO_PREFLIGHT_POLL_INTERVAL_MS: '150',
      SUPREMO_PREFLIGHT_POLL_TIMEOUT_MS: '3000',
    }
    return { env, callLogFile }
  }

  function preWarmDaemon(env: NodeJS.ProcessEnv): void {
    execFileSync(join(dir, LOCAL_SUPREMO_CLI_BIN_REL), ['daemon', '--ensure'], {
      cwd: dir,
      env,
      stdio: 'ignore',
    })
  }

  function runResume(env: NodeJS.ProcessEnv): { status: number; result: ResumeJson | null; elapsedMs: number } {
    const start = Date.now()
    try {
      const out = execFileSync(process.execPath, [join(dir, 'scripts/supremo-status.mjs'), '--ensure'], {
        cwd: dir,
        env,
        encoding: 'utf8',
        timeout: 20_000,
      })
      return { status: 0, result: JSON.parse(out) as ResumeJson, elapsedMs: Date.now() - start }
    } catch (err) {
      const e = err as { status: number | null; stdout: string }
      return {
        status: e.status ?? 1,
        result: e.stdout ? (JSON.parse(e.stdout) as ResumeJson) : null,
        elapsedMs: Date.now() - start,
      }
    }
  }

  it(
    'processo inicia imediatamente (running=true) mas health só vira true ~800ms depois → preflight ESPERA e conclui com sucesso, sem falso negativo',
    () => {
      const port = 21000 + Math.floor(Math.random() * 4000)
      const { env, callLogFile } = setup(port, 800)
      preWarmDaemon(env)

      const { status, result, elapsedMs } = runResume(env)

      expect(status).toBe(0)
      expect(result?.preview.healthy).toBe(true)
      expect(result?.daemon.healthy).toBe(true)
      // Prova que ESPEROU de verdade (não passou batido antes do processo
      // ficar pronto) — mas sem estourar a janela de 3s configurada.
      expect(elapsedMs).toBeGreaterThanOrEqual(750)
      expect(elapsedMs).toBeLessThan(3_000)
      // Ficou saudável dentro da 1ª janela — a 2ª tentativa de ensure NUNCA
      // precisou rodar.
      expect(readFileSync(callLogFile, 'utf8').trim()).toBe('1')
    },
    30_000,
  )

  it(
    'caminho saudável (já healthy antes do ensure) continua imediato — nenhum polling, nenhuma chamada de ensure',
    () => {
      const port = 21000 + Math.floor(Math.random() * 4000)
      const { env, callLogFile } = setup(port, 0)
      preWarmDaemon(env)
      // Sobe o preview de propósito ANTES do resume, já saudável.
      execFileSync(process.execPath, [join(dir, 'scripts/preview.mjs'), 'ensure'], {
        cwd: dir,
        env,
        stdio: 'ignore',
      })

      const start = Date.now()
      const { status, result } = runResume(env)
      const elapsedMs = Date.now() - start

      expect(status).toBe(0)
      expect(result?.preview.healthy).toBe(true)
      // Já saudável: o bloco de ensure/polling inteiro é pulado — rápido de
      // verdade, nunca perto da janela de 3s configurada.
      expect(elapsedMs).toBeLessThan(1_000)
      // Nenhuma chamada NOVA de ensure — só a que o teste fez pra pré-aquecer.
      expect(readFileSync(callLogFile, 'utf8').trim()).toBe('1')
    },
    30_000,
  )
})

/**
 * Daemon ensure 100% local e network-free (v3.4.4, teste-v3-15) — E2E REAL.
 *
 * A causa raiz provada do v3-15: `npx --yes supremo-cli daemon --ensure`
 * introduzia uma dependência de rede no hot path local — no Terminal (rede
 * plena) resolve em segundos; no sandbox do agente (rede restrita), o
 * retry/backoff interno do próprio npm podia travar por ~1m30 antes de
 * desistir. A correção não é um timeout menor — é ELIMINAR a chamada de
 * rede: `supremo-cli` é devDependency PINADA do scaffold (mesmo padrão já
 * usado pra CLI do Supabase — `packages/cli/src/bootstrap.ts
 * #resolveSupabaseBin`), então `node_modules/.bin/supremo` existe depois de
 * um `npm install`/`npm ci` comum, e `--ensure` resolve esse caminho DIRETO.
 *
 * Os testes abaixo colocam um `npx` ENVENENADO no PATH — falha sempre e
 * registra toda chamada recebida — pra provar que `--ensure` religa
 * daemon+preview com sucesso mesmo com QUALQUER acesso a `npx`/registry
 * deliberadamente indisponível, e que `npx` nunca é sequer invocado (o log
 * de chamadas do veneno fica vazio).
 */
describe('supremo:resume — daemon ensure 100% local e network-free (v3.4.4, teste-v3-15)', () => {
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

  /** `npx` que SEMPRE falha e registra a chamada — prova que, se `--ensure`
   * ainda dependesse de rede, o teste falharia; e prova (via log vazio) que
   * `npx` nunca chega a ser invocado quando a CLI local está disponível. */
  function poisonedNpxShim(callLogFile: string): string {
    return `#!/usr/bin/env node
import fs from 'node:fs'
fs.appendFileSync(${JSON.stringify(callLogFile)}, JSON.stringify(process.argv.slice(2)) + '\\n')
console.error('npx não deveria ser chamado — rede indisponível de propósito (teste-v3-15)')
process.exit(1)
`
  }

  function setup(port: number, installCliLocally: boolean): { env: NodeJS.ProcessEnv; poisonedNpxLog: string } {
    dir = mkdtempSync(join(tmpdir(), 'supremo-resume-offline-'))
    const poisonBinDir = join(dir, 'poisoned-bin')
    mkdirSync(poisonBinDir, { recursive: true })
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
      JSON.stringify({ name: 'resume-offline-fixture', scripts: { dev: 'node scripts/dev-server.mjs' } }),
    )
    if (installCliLocally) installLocalSupremoCliShim(dir)

    const poisonedNpxLog = join(dir, 'poisoned-npx-call-log.jsonl')
    writeFileSync(join(poisonBinDir, 'npx'), poisonedNpxShim(poisonedNpxLog), { mode: 0o755 })

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      // O ÚNICO `npx` alcançável é o envenenado — se `--ensure` tentar
      // resolver por rede de qualquer jeito, cai nele e falha na hora.
      PATH: `${poisonBinDir}:${process.env.PATH}`,
      PORT: String(port),
      RESUME_TEST_CALL_LOG: join(dir, 'npx-call-log.jsonl'),
      SUPREMO_PREFLIGHT_POLL_INTERVAL_MS: '20',
      SUPREMO_PREFLIGHT_POLL_TIMEOUT_MS: '2000',
    }
    return { env, poisonedNpxLog }
  }

  function runResume(env: NodeJS.ProcessEnv): { status: number; result: ResumeJson | null } {
    try {
      const out = execFileSync(process.execPath, [join(dir, 'scripts/supremo-status.mjs'), '--ensure'], {
        cwd: dir,
        env,
        encoding: 'utf8',
        timeout: 20_000,
      })
      return { status: 0, result: JSON.parse(out) as ResumeJson }
    } catch (err) {
      const e = err as { status: number | null; stdout: string }
      return { status: e.status ?? 1, result: e.stdout ? (JSON.parse(e.stdout) as ResumeJson) : null }
    }
  }

  it(
    'cenário A — projeto novo, primeiro prompt: religa daemon+preview OFFLINE (npx envenenado, nunca chamado)',
    () => {
      const port = 21000 + Math.floor(Math.random() * 4000)
      const { env, poisonedNpxLog } = setup(port, true)
      expect(existsSync(join(dir, '.supremo'))).toBe(false)

      const { status, result } = runResume(env)

      expect(status).toBe(0)
      expect(result?.daemon.healthy).toBe(true)
      expect(result?.preview.healthy).toBe(true)
      // O supervisor pode legitimamente relocalizar de porta se a
      // preferida colidir com outro teste rodando em paralelo (mesma
      // resiliência já coberta em preview-ownership.test.ts) — o que
      // "abre sozinho" precisa é uma URL real e consistente com o que
      // ficou persistido, não necessariamente a porta exata sorteada.
      const finalPort = Number(readFileSync(join(dir, '.supremo/preview.port'), 'utf8').trim())
      expect(result?.preview.url).toBe(`http://localhost:${finalPort}`)
      // Prova mais forte que "funcionou apesar do npx falhar": o npx
      // envenenado nunca foi sequer CHAMADO — o log de chamadas está vazio.
      expect(existsSync(poisonedNpxLog)).toBe(false)
    },
    30_000,
  )

  it(
    'cenário B — preview+daemon mortos, primeiro prompt da nova sessão: religa os dois OFFLINE (npx envenenado, nunca chamado)',
    () => {
      const port = 21000 + Math.floor(Math.random() * 4000)
      const { env, poisonedNpxLog } = setup(port, true)

      // Sobe os dois de propósito com a CLI local (sem passar pelo npx
      // envenenado — installLocalSupremoCliShim já é o caminho local), depois
      // mata — "estava tudo de pé numa sessão anterior, o app fechou".
      execFileSync(process.execPath, [join(dir, 'scripts/preview.mjs'), 'ensure'], {
        cwd: dir,
        env,
        stdio: 'ignore',
        timeout: 15_000,
      })
      execFileSync(join(dir, LOCAL_SUPREMO_CLI_BIN_REL), ['daemon', '--ensure'], {
        cwd: dir,
        env,
        stdio: 'ignore',
      })
      const previewPidBefore = Number(readFileSync(join(dir, '.supremo/preview.pid'), 'utf8').trim())
      const daemonPidBefore = daemonState(dir).pid!
      process.kill(previewPidBefore, 'SIGKILL')
      process.kill(daemonPidBefore, 'SIGKILL')

      const { status, result } = runResume(env)

      expect(status).toBe(0)
      expect(result?.daemon.healthy).toBe(true)
      expect(result?.preview.healthy).toBe(true)
      const finalPort = Number(readFileSync(join(dir, '.supremo/preview.port'), 'utf8').trim())
      expect(result?.preview.url).toBe(`http://localhost:${finalPort}`)
      expect(existsSync(poisonedNpxLog)).toBe(false)
    },
    30_000,
  )

  it(
    'CLI local ausente (node_modules/.bin/supremo não existe) → fail-closed com mensagem clara, nunca npx/npm install automático',
    () => {
      const port = 21000 + Math.floor(Math.random() * 4000)
      // installCliLocally=false — simula node_modules nunca instalado, ou
      // apagado/corrompido.
      const { env, poisonedNpxLog } = setup(port, false)
      expect(existsSync(join(dir, LOCAL_SUPREMO_CLI_BIN_REL))).toBe(false)

      const { status, result } = runResume(env)

      expect(status).not.toBe(0)
      expect(result?.daemon.healthy).toBe(false)
      // Mensagem clara e específica — não um erro genérico.
      expect(result?.daemon.error).toMatch(/supremo-cli local ausente/i)
      expect(result?.daemon.error).toMatch(/npm install/i)
      // Nunca cai pra npx/registry como "solução" — o envenenado segue mudo.
      expect(existsSync(poisonedNpxLog)).toBe(false)
      // Nunca tenta rodar `npm install` sozinho (isso seria bootstrap
      // automático, fora do preflight) — node_modules continua exatamente
      // como estava (só o node_modules/.bin do preview shim, se algum).
      expect(existsSync(join(dir, LOCAL_SUPREMO_CLI_BIN_REL))).toBe(false)
    },
    30_000,
  )
})
