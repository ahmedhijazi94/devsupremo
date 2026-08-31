import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { CompanionEvent } from './protocol'
import type { GitOps } from './git'
import { findFreePort, type DevHandle, type Runner } from './runner'
import {
  detectPackageManager,
  devCommand,
  installCommand,
  preferredPort,
  safeEditPath,
  workspaceDir,
} from './workspace'

/**
 * O coração do companion: prepara o workspace isolado, sobe o Next real, mantém
 * vivo (restart se cair), aplica edições direto no filesystem (HMR) e roda
 * validação em background — tudo por projeto, sem um projeto tocar o outro.
 *
 * fs real (dá pra testar com diretório temporário); runner e git injetados
 * (testáveis com fakes). Nenhum shell arbitrário: os comandos vêm de listas
 * fixas por gerenciador detectado.
 */

interface ProjectState {
  status: (typeof import('./protocol'))['RUNTIME_STATUS'][number]
  dir: string
  dev: DevHandle | null
  starting: Promise<void> | null
  validating: boolean
  restarts: number
}

export interface ManagerDeps {
  userId: string
  workspaceBase: string
  runner: Runner
  git: GitOps
  emit: (event: CompanionEvent) => void
}

export class ProjectManager {
  private readonly projects = new Map<string, ProjectState>()

  constructor(private readonly deps: ManagerDeps) {}

  private state(projectId: string): ProjectState {
    let s = this.projects.get(projectId)
    if (!s) {
      s = {
        status: 'offline',
        dir: workspaceDir(this.deps.workspaceBase, this.deps.userId, projectId),
        dev: null,
        starting: null,
        validating: false,
        restarts: 0,
      }
      this.projects.set(projectId, s)
    }
    return s
  }

  private setStatus(
    projectId: string,
    status: ProjectState['status'],
    detail?: string,
  ): void {
    const s = this.state(projectId)
    s.status = status
    this.deps.emit({
      type: 'runtime_status',
      projectId,
      status,
      previewUrl: s.dev?.url ?? null,
      devPort: s.dev?.port ?? null,
      detail,
    })
  }

  /** Sobe (ou reusa) o projeto. Idempotente: chamada repetida não duplica. */
  async start(cmd: {
    projectId: string
    repoFullName: string
    branch: string
    cloneToken?: string
  }): Promise<void> {
    const s = this.state(cmd.projectId)

    // Já rodando: só reanuncia o preview (idempotência).
    if (s.status === 'online' && s.dev) {
      this.deps.emit({
        type: 'preview_ready',
        projectId: cmd.projectId,
        url: s.dev.url,
        port: s.dev.port,
      })
      return
    }
    // Já subindo: dedup — espera a subida em andamento.
    if (s.starting) return s.starting

    s.starting = this.doStart(cmd).finally(() => {
      s.starting = null
    })
    return s.starting
  }

  private async doStart(cmd: {
    projectId: string
    repoFullName: string
    branch: string
    cloneToken?: string
  }): Promise<void> {
    const s = this.state(cmd.projectId)
    try {
      this.setStatus(cmd.projectId, 'preparing')

      // 1. Bootstrap/sync via git (fora do caminho crítico da edição).
      const token = cmd.cloneToken ?? ''
      if (!existsSync(join(s.dir, '.git'))) {
        await mkdir(dirname(s.dir), { recursive: true })
        const url = `https://github.com/${cmd.repoFullName}.git`
        await this.deps.git.clone(url, token, s.dir)
      } else if (token) {
        await this.deps.git.pull(s.dir, token).catch(() => {
          // pull falhou (offline/conflito): segue com o cache local
        })
      }

      // 2. Detecta o gerenciador e instala SÓ se necessário.
      const files = await readdir(s.dir).catch(() => [] as string[])
      const pm = detectPackageManager(files)
      if (await this.needsInstall(s.dir)) {
        await this.deps.runner.exec(installCommand(pm), s.dir, process.env, (l) =>
          this.deps.emit({ type: 'log', projectId: cmd.projectId, stream: 'install', line: l }),
        )
        await this.markInstalled(s.dir)
      }

      // 3. Sobe o dev server numa porta livre (sem conflito entre projetos).
      this.setStatus(cmd.projectId, 'starting')
      const port = await findFreePort(preferredPort(cmd.projectId))
      const dev = await this.deps.runner.startDev(
        devCommand(pm),
        s.dir,
        port,
        process.env,
        (l) => this.deps.emit({ type: 'log', projectId: cmd.projectId, stream: 'dev', line: l }),
      )
      s.dev = dev
      s.restarts = 0

      // 4. Restart se o dev cair sozinho (backoff simples, no máx 3x).
      dev.onExit(() => {
        s.dev = null
        if (s.status === 'online' && s.restarts < 3) {
          s.restarts++
          void this.doStart(cmd)
        } else if (s.status === 'online') {
          this.setStatus(cmd.projectId, 'error', 'Dev server caiu repetidamente.')
        }
      })

      this.setStatus(cmd.projectId, 'online')
      this.deps.emit({ type: 'preview_ready', projectId: cmd.projectId, url: dev.url, port: dev.port })
    } catch (error) {
      this.setStatus(cmd.projectId, 'error', String(error))
      this.deps.emit({
        type: 'error',
        projectId: cmd.projectId,
        kind: 'dev',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  async stop(projectId: string): Promise<void> {
    const s = this.projects.get(projectId)
    if (!s) return
    const dev = s.dev
    s.dev = null
    s.status = 'offline'
    await dev?.stop()
    this.setStatus(projectId, 'offline')
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.projects.keys()].map((id) => this.stop(id)))
  }

  /** Edição DIRETA no filesystem — o caminho rápido (HMR). safeEditPath é a cerca. */
  async applyEdits(
    projectId: string,
    edits: Array<{ path: string; content: string | null }>,
  ): Promise<void> {
    const s = this.state(projectId)
    for (const edit of edits) {
      const abs = safeEditPath(s.dir, edit.path) // lança se escapar do projeto
      if (edit.content === null) {
        await rm(abs, { force: true })
      } else {
        await mkdir(dirname(abs), { recursive: true })
        await writeFile(abs, edit.content, 'utf8')
      }
    }
  }

  async gitStatus(projectId: string): Promise<string> {
    return this.deps.git.status(this.state(projectId).dir)
  }

  async gitSync(projectId: string, message: string, token: string): Promise<void> {
    await this.deps.git.commitAndPush(this.state(projectId).dir, message, token)
  }

  /** Validação em background: NÃO bloqueia; emite o resultado quando termina. */
  runValidation(projectId: string, kind: 'fast' | 'full'): void {
    const s = this.state(projectId)
    if (s.validating) return // um por vez por projeto (evita acúmulo)
    s.validating = true

    const script =
      kind === 'full' ? ['npm', 'run', 'test'] : ['npm', 'run', 'typecheck']
    void (async () => {
      let output = ''
      const code = await this.deps.runner
        .exec(script, s.dir, process.env, (l) => {
          output += l + '\n'
          this.deps.emit({ type: 'log', projectId, stream: 'validation', line: l })
        })
        .catch(() => 1)
      s.validating = false
      this.deps.emit({
        type: 'validation_result',
        projectId,
        kind,
        status: code === 0 ? 'passed' : 'failed',
        revision: null,
        summary:
          code === 0
            ? `${kind}: passou`
            : `${kind}: falhou — ${output.split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 200)}`,
      })
    })()
  }

  // ── install-only-when-needed: marca o hash do lockfile após instalar ──

  private markerPath(dir: string): string {
    return join(dir, 'node_modules', '.supremo-install')
  }

  private async lockHash(dir: string): Promise<string> {
    for (const lock of ['pnpm-lock.yaml', 'yarn.lock', 'package-lock.json']) {
      try {
        const content = await readFile(join(dir, lock), 'utf8')
        return createHash('sha1').update(lock).update(content).digest('hex')
      } catch {
        // tenta o próximo
      }
    }
    return 'no-lock'
  }

  private async needsInstall(dir: string): Promise<boolean> {
    if (!existsSync(join(dir, 'node_modules'))) return true
    try {
      const marker = await readFile(this.markerPath(dir), 'utf8')
      return marker.trim() !== (await this.lockHash(dir))
    } catch {
      return true // sem marcador → instala
    }
  }

  private async markInstalled(dir: string): Promise<void> {
    await writeFile(this.markerPath(dir), await this.lockHash(dir), 'utf8').catch(
      () => {},
    )
  }
}
