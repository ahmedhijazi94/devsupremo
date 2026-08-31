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
export class Companion {
  // Último token de curta duração por projeto (do start_project), reusado para
  // pull/sync até o próximo start renovar. Nunca logado (registrado como secret).
  private tokens = new Map<string, string>()

  constructor(
    private readonly transport: Transport,
    private readonly manager: ProjectManager,
    private readonly logger: Logger,
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
        if (cmd.cloneToken) {
          this.logger.addSecret(cmd.cloneToken)
          this.tokens.set(cmd.projectId, cmd.cloneToken)
        }
        this.logger.info(`start_project ${cmd.projectId}`)
        void this.manager.start(cmd)
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
