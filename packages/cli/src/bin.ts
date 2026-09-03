#!/usr/bin/env node
import { Command } from 'commander'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
// Fonte ÚNICA da versão: o próprio package.json (o esbuild inlina no bundle, e o
// prepublishOnly reconstrói antes de publicar). Assim `--version` nunca diverge da
// versão publicada.
import pkg from '../package.json'
import { isKnownOrGlobal, unknownCommandMessage } from './command-guard'

const program = new Command()

program
  .name('supremo')
  .description('CLI do Supremo (bootstrap + ponte MCP)')
  .version(pkg.version)

/**
 * Roda ANTES de `program.parse()`: um comando não-registrado nunca cai
 * silenciosamente na ponte MCP (ver `command-guard.ts`) — sai com um erro claro
 * e acionável em vez disso.
 */
function guardUnknownCommand(argv: string[]): void {
  const first = argv[0]
  if (isKnownOrGlobal(first)) return
  console.error(unknownCommandMessage(first!))
  process.exit(1)
}

const DEFAULT_URL = 'https://supremo.app/api/mcp'

interface ClaudeConfig {
  mcpServers?: Record<string, unknown>
  [key: string]: unknown
}

function claudeDesktopConfigPath(): string {
  if (process.platform === 'darwin') {
    return path.join(
      os.homedir(),
      'Library',
      'Application Support',
      'Claude',
      'claude_desktop_config.json'
    )
  }
  if (process.platform === 'win32') {
    return path.join(
      process.env.APPDATA ?? os.homedir(),
      'Claude',
      'claude_desktop_config.json'
    )
  }
  return path.join(os.homedir(), '.config', 'Claude', 'claude_desktop_config.json')
}

program
  .command('connect')
  .description('Configura o Claude Desktop para usar o Supremo remoto')
  .requiredOption('-t, --token <token>', 'Token gerado em /mcps')
  .option('-u, --url <url>', 'Endpoint MCP do Supremo', DEFAULT_URL)
  .action((options: { token: string; url: string }) => {
    if (!options.token.startsWith('sup_')) {
      console.error('Token inválido: deve começar com "sup_". Gere um em /mcps.')
      process.exit(1)
    }

    const configPath = claudeDesktopConfigPath()
    let config: ClaudeConfig = {}

    if (fs.existsSync(configPath)) {
      try {
        config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as ClaudeConfig
      } catch {
        console.error(
          `${configPath} existe mas não é JSON válido. Corrija ou remova o arquivo antes de continuar.`
        )
        process.exit(1)
      }
    }

    config.mcpServers = config.mcpServers ?? {}
    config.mcpServers.supremo = {
      command: 'npx',
      args: ['-y', 'supremo-cli', 'mcp'],
      env: { SUPREMO_URL: options.url, SUPREMO_TOKEN: options.token },
    }

    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)

    console.log(`Configurado em ${configPath}`)
    console.log(`Endpoint: ${options.url}`)
    console.log('Reinicie o Claude Desktop para carregar a conexão.')
  })

program
  .command('bootstrap <project-id>')
  .description('Prepara o workspace local do projeto (autoriza no navegador)')
  .requiredOption('-u, --url <url>', 'URL do Supremo, ex.: https://supremo.app')
  .option('-d, --dir <dir>', 'Pasta-base onde criar o projeto (padrão: pasta atual)')
  .option('--start', '(sem efeito — preview e daemon já sobem sempre; aceito por compatibilidade)')
  .action(
    async (
      projectId: string,
      options: { url: string; dir?: string; start?: boolean },
    ) => {
      const { runBootstrap } = await import('./bootstrap')
      try {
        await runBootstrap({
          projectId,
          url: options.url,
          dir: options.dir,
          start: options.start,
        })
      } catch (error) {
        console.error(
          `\n✗ ${error instanceof Error ? error.message : String(error)}\n`,
        )
        process.exit(1)
      }
    },
  )

program
  .command('checkpoint <summary...>')
  .description('Cria um checkpoint LOCAL do pedido concluído (sem rede)')
  // Opcionais — preenchidos SÓ se o host do agente fornecer (Histórico
  // consegue então ligar o checkpoint à conversa/turno de origem). Ausência
  // não muda nada: o resumo continua sendo a identidade funcional do ponto.
  .option('--conversation-id <id>', 'ID da conversa, se o host fornecer')
  .option('--message-id <id>', 'ID da mensagem/turno, se o host fornecer')
  .option('--origin-agent <name>', 'Nome do agente (ex.: claude, codex)')
  .action(async (
    summaryParts: string[],
    options: { conversationId?: string; messageId?: string; originAgent?: string },
  ) => {
    const { runCheckpoint, defaultCheckpointDeps, readProjectId, NothingToCheckpointError } =
      await import('./checkpoint')
    const cwd = process.cwd()
    const projectId = readProjectId(cwd)
    if (!projectId) {
      console.error('✗ .supremo/project.json ausente — rode o bootstrap primeiro.')
      process.exit(1)
    }
    const summary = summaryParts.join(' ').trim()
    if (!summary) {
      console.error('✗ Informe um resumo: supremo checkpoint "home minimalista"')
      process.exit(1)
    }
    try {
      // Garante o daemon vivo (idempotente) antes de enfileirar — push assíncrono.
      const { ensureDaemon } = await import('./daemon')
      try {
        ensureDaemon(cwd)
      } catch {
        // sem daemon: o checkpoint local ainda é válido; o daemon sobe depois
      }
      const record = runCheckpoint(summary, projectId, defaultCheckpointDeps(cwd), {
        conversationId: options.conversationId,
        messageId: options.messageId,
        originAgent: options.originAgent,
      })
      console.log(
        `✓ checkpoint ${record.checkpointId.slice(0, 8)} (${record.riskLevel}) — ` +
          `push em background. Pode pedir a próxima mudança.`,
      )
    } catch (error) {
      if (error instanceof NothingToCheckpointError) {
        console.log('• Nada mudou — nenhum checkpoint criado.')
        return
      }
      console.error(`✗ ${error instanceof Error ? error.message : String(error)}`)
      process.exit(1)
    }
  })

program
  .command('daemon')
  .description('Checkpoint daemon: envia checkpoints em background (push/PR)')
  .option('--ensure', 'Garante o daemon vivo (sobe desacoplado se preciso)')
  .option('--status', 'Mostra se o daemon está rodando')
  .option('--stop', 'Para o daemon')
  .option('--once', 'Drena a fila uma vez e sai (debug/CI)')
  .action(
    async (options: {
      ensure?: boolean
      status?: boolean
      stop?: boolean
      once?: boolean
    }) => {
      const daemon = await import('./daemon')
      const cwd = process.cwd()
      if (options.status) {
        // Machine-readable (JSON) — diagnóstico, não é para o usuário comum
        // rodar; a UI do Supremo (Histórico) é o lugar humano para isto.
        console.log(JSON.stringify(daemon.daemonStatus(cwd)))
        return
      }
      if (options.stop) {
        daemon.stopDaemon(cwd)
        console.log('daemon parado.')
        return
      }
      if (options.ensure) {
        const r = daemon.ensureDaemon(cwd)
        console.log(r === 'reuse' ? '✓ daemon já ativo' : '✓ daemon iniciado')
        return
      }
      if (options.once) {
        const cfg = daemon.readProjectConfig(cwd)
        if (!cfg) {
          console.error('✗ .supremo/project.json ausente/incompleto.')
          process.exit(1)
        }
        const { resolveKeychain } = await import('./keychain')
        const kc = resolveKeychain()
        const n = await daemon.drainOnce({
          projectId: cfg.projectId,
          apiBaseUrl: cfg.apiBaseUrl,
          cwd,
          getSecret: () => kc.get(cfg.projectId),
        })
        console.log(`processados: ${n}`)
        return
      }
      // Sem flags: é o processo detached — roda o loop persistente.
      await daemon.runDaemonLoop(cwd)
    },
  )

program
  .command('mcp', { isDefault: true })
  .description('Roda a ponte MCP (o cliente chama isto automaticamente)')
  .action(async () => {
    await import('./index')
  })

guardUnknownCommand(process.argv.slice(2))
program.parse()
