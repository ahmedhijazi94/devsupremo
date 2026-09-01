#!/usr/bin/env node
import { Command } from 'commander'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { configPath, loadConfig } from './config'
import { Logger } from './logger'
import { ProjectManager } from './project-manager'
import { RealRunner } from './runner'
import { RealGit } from './git'
import { Companion } from './companion'
import { handshake, SupabaseRealtimeTransport } from './supabase-transport'

const program = new Command()
program
  .name('supremo-runtime')
  .description('Runtime local do Supremo — roda o preview Next real na sua máquina.')

program
  .command('login')
  .description('Salva a URL do Supremo e seu token (uma vez).')
  .requiredOption('--url <url>', 'URL do Supremo, ex.: https://supremo-three.vercel.app')
  .requiredOption('--token <token>', 'Seu token pessoal (sup_…), gerado em /mcps')
  .action((opts: { url: string; token: string }) => {
    const path = configPath()
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(
      path,
      JSON.stringify(
        {
          supremoUrl: opts.url.replace(/\/$/, ''),
          token: opts.token,
          workspaceBase: join(homedir(), '.supremo', 'workspaces'),
        },
        null,
        2,
      ),
    )
    // eslint-disable-next-line no-console
    console.log(`Salvo em ${path}. Agora rode: supremo-runtime run`)
  })

program
  .command('run', { isDefault: true })
  .description('Conecta ao Supremo e fica pronto para subir previews locais.')
  .action(async () => {
    const config = loadConfig()
    const logger = new Logger(join(homedir(), '.supremo', 'companion.log'))
    logger.addSecret(config.token)

    let session
    try {
      session = await handshake(config)
    } catch (error) {
      logger.error(`Não conectou: ${error instanceof Error ? error.message : error}`)
      process.exit(1)
    }
    logger.addSecret(session.session.accessToken)
    logger.addSecret(session.session.refreshToken)

    const transport = new SupabaseRealtimeTransport(session)
    const manager = new ProjectManager({
      userId: session.userId,
      workspaceBase: config.workspaceBase,
      runner: new RealRunner(),
      git: new RealGit(new RealRunner()),
      emit: (event) => transport.send(event),
    })
    // Busca a credencial de git no Supremo (autenticado com o token do dev).
    const fetchGitCredentials = async (projectId: string) => {
      const res = await fetch(`${config.supremoUrl}/api/companion/git-credentials`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ projectId }),
        signal: AbortSignal.timeout(30_000),
      })
      if (!res.ok) {
        throw new Error(`Credencial de git negada (${res.status}).`)
      }
      const data = (await res.json()) as {
        token: string
        repoFullName: string
        branch: string
      }
      return data
    }
    const companion = new Companion(transport, manager, logger, fetchGitCredentials)

    await companion.start()
    logger.info(`Online como ${session.userId}. Aguardando comandos do Supremo.`)

    const shutdown = async () => {
      logger.info('Encerrando…')
      await companion.stop()
      process.exit(0)
    }
    process.on('SIGINT', () => void shutdown())
    process.on('SIGTERM', () => void shutdown())
  })

program.parseAsync(process.argv)
