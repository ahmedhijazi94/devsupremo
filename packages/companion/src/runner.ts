import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'

/**
 * Execução de processos filhos: install/git (roda até sair) e dev server
 * (fica vivo). Atrás de uma interface para o project-manager ser testável com
 * um runner falso — sem spawnar nada de verdade nos testes.
 *
 * Segurança: o comando vem SEMPRE de listas fixas (install/dev por gerenciador
 * detectado), nunca shell arbitrário. `shell:false` no spawn — sem interpolação
 * de shell, sem injeção.
 */

export interface DevHandle {
  port: number
  url: string
  stop(): Promise<void>
  onExit(cb: (code: number | null) => void): void
}

export interface Runner {
  /** Roda um comando até terminar (install, git). Devolve o exit code. */
  exec(
    cmd: string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
    onLine?: (line: string) => void,
  ): Promise<number>
  /** Sobe o dev server; resolve quando estiver PRONTO de verdade. */
  startDev(
    cmd: string[],
    cwd: string,
    port: number,
    env: NodeJS.ProcessEnv,
    onLine?: (line: string) => void,
  ): Promise<DevHandle>
}

/** Acha uma porta livre a partir de uma preferida (evita conflito entre projetos). */
export async function findFreePort(preferred: number, tries = 50): Promise<number> {
  for (let port = preferred; port < preferred + tries; port++) {
    if (await isFree(port)) return port
  }
  throw new Error('Nenhuma porta livre na faixa.')
}

function isFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer()
    srv.once('error', () => resolve(false))
    srv.once('listening', () => srv.close(() => resolve(true)))
    srv.listen(port, '127.0.0.1')
  })
}

// Next imprime a URL local quando sobe; usamos isso para "pronto de verdade".
const READY_RE = /(https?:\/\/localhost:\d+)|✓\s*Ready|ready in/i

export class RealRunner implements Runner {
  exec(
    cmd: string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
    onLine?: (line: string) => void,
  ): Promise<number> {
    return new Promise((resolve, reject) => {
      const [bin, ...args] = cmd
      if (!bin) return reject(new Error('Comando vazio.'))
      const child = spawn(bin, args, { cwd, env, shell: false })
      pipeLines(child, onLine)
      child.on('error', reject)
      child.on('exit', (code) => resolve(code ?? 0))
    })
  }

  startDev(
    cmd: string[],
    cwd: string,
    port: number,
    env: NodeJS.ProcessEnv,
    onLine?: (line: string) => void,
  ): Promise<DevHandle> {
    return new Promise((resolve, reject) => {
      const [bin, ...args] = cmd
      if (!bin) return reject(new Error('Comando vazio.'))
      const child = spawn(bin, args, {
        cwd,
        env: { ...env, PORT: String(port) },
        shell: false,
      })

      let settled = false
      const exitCbs: Array<(code: number | null) => void> = []

      const handle: DevHandle = {
        port,
        url: `http://localhost:${port}`,
        stop: () => stopTree(child),
        onExit: (cb) => exitCbs.push(cb),
      }

      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true
          void stopTree(child)
          reject(new Error('Dev server não ficou pronto a tempo.'))
        }
      }, 180_000)

      pipeLines(child, (line) => {
        onLine?.(line)
        if (!settled && READY_RE.test(line)) {
          settled = true
          clearTimeout(timeout)
          resolve(handle)
        }
      })

      child.on('error', (err) => {
        if (!settled) {
          settled = true
          clearTimeout(timeout)
          reject(err)
        }
      })
      child.on('exit', (code) => {
        clearTimeout(timeout)
        for (const cb of exitCbs) cb(code)
        if (!settled) {
          settled = true
          reject(new Error(`Dev server saiu antes de ficar pronto (code ${code}).`))
        }
      })
    })
  }
}

function pipeLines(child: ChildProcess, onLine?: (line: string) => void): void {
  if (!onLine) return
  const feed = (buf: Buffer) => {
    for (const line of buf.toString('utf8').split('\n')) {
      const trimmed = line.trimEnd()
      if (trimmed) onLine(trimmed)
    }
  }
  child.stdout?.on('data', feed)
  child.stderr?.on('data', feed)
}

/** Mata o processo e seus filhos (o dev server costuma ter subprocessos). */
function stopTree(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.killed) return resolve()
    child.once('exit', () => resolve())
    // SIGTERM no grupo; força depois de um tempo.
    try {
      child.kill('SIGTERM')
    } catch {
      return resolve()
    }
    setTimeout(() => {
      try {
        if (child.exitCode === null) child.kill('SIGKILL')
      } catch {
        // já morreu
      }
      resolve()
    }, 5_000)
  })
}
