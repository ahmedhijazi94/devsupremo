import { parseCommand } from './protocol'
import type { Transport } from './transport'
import type { ProjectManager } from './project-manager'
import type { Logger } from './logger'

/**
 * O cérebro do companion: liga o Transport ao ProjectManager, roteando só
 * comandos VÁLIDOS (parse defensivo). Escopo: o companion pertence a UM usuário
 * (seu token) e só recebe comandos do canal dele — cross-user não chega. Todo
 * projeto é resolvido sob o workspace desse usuário, então nada toca outro user.
 *
 * NÃO existe caminho de shell arbitrário: o único jeito de fazer o companion
 * agir é um comando do protocolo, e cada um mapeia para uma ação fixa e
 * limitada ao projeto autorizado.
 */
/** Credencial de git resolvida no servidor para um projeto (curta duração). */
export interface GitCredentials {
  token: string
  repoFullName: string
  branch: string
}

export class Companion {
  // Último token de curta duração por projeto (do git-credentials), reusado para
  // git_sync até renovar. Nunca logado (registrado como secret).
  private tokens = new Map<string, string>()

  constructor(
    private readonly transport: Transport,
    private readonly manager: ProjectManager,
    private readonly logger: Logger,
    /** Busca a credencial de git no Supremo (endpoint autenticado). */
    private readonly fetchGitCredentials: (
      projectId: string,
    ) => Promise<GitCredentials>,
  ) {}

  async start(): Promise<void> {
    this.transport.onMessage((raw) => this.route(raw))
    await this.transport.start()
    this.logger.info('Companion conectado e ouvindo comandos.')
  }

  private route(raw: unknown): void {
    const cmd = parseCommand(raw)
    if (!cmd) {
      this.logger.error('Comando inválido/ignorado.')
      return
    }

    switch (cmd.type) {
      case 'start_project': {
        this.logger.info(`start_project ${cmd.projectId}`)
        // A credencial de git NÃO vem no comando (canal sem segredo): busca no
        // Supremo, autenticado, só pra este projeto.
        void (async () => {
          try {
            const creds = await this.fetchGitCredentials(cmd.projectId)
            this.logger.addSecret(creds.token)
            this.tokens.set(cmd.projectId, creds.token)
            await this.manager.start({
              projectId: cmd.projectId,
              repoFullName: creds.repoFullName || cmd.repoFullName,
              branch: creds.branch || cmd.branch,
              cloneToken: creds.token,
            })
          } catch (error) {
            this.transport.send({
              type: 'error',
              projectId: cmd.projectId,
              kind: 'clone',
              message: error instanceof Error ? error.message : String(error),
            })
          }
        })()
        break
      }
      case 'stop_project': {
        this.logger.info(`stop_project ${cmd.projectId}`)
        void this.manager.stop(cmd.projectId)
        break
      }
      case 'apply_edits': {
        this.logger.info(`apply_edits ${cmd.projectId} (${cmd.edits.length})`)
        void this.manager.applyEdits(cmd.projectId, cmd.edits).catch((error) => {
          this.transport.send({
            type: 'error',
            projectId: cmd.projectId,
            kind: 'unknown',
            message: error instanceof Error ? error.message : String(error),
          })
        })
        break
      }
      case 'run_validation': {
        this.logger.info(`run_validation ${cmd.projectId} ${cmd.kind}`)
        this.manager.runValidation(cmd.projectId, cmd.kind)
        break
      }
      case 'git_sync': {
        const token = this.tokens.get(cmd.projectId)
        if (!token) {
          this.transport.send({
            type: 'error',
            projectId: cmd.projectId,
            kind: 'unknown',
            message: 'Sem credencial de git válida — abra o projeto de novo.',
          })
          break
        }
        this.logger.info(`git_sync ${cmd.projectId}`)
        void this.manager.gitSync(cmd.projectId, cmd.message, token).catch((error) => {
          this.transport.send({
            type: 'error',
            projectId: cmd.projectId,
            kind: 'unknown',
            message: error instanceof Error ? error.message : String(error),
          })
        })
        break
      }
    }
  }

  async stop(): Promise<void> {
    await this.manager.stopAll()
    await this.transport.stop()
  }
}
