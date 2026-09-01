#!/usr/bin/env node
import { Command } from 'commander'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const program = new Command()

program
  .name('supremo')
  .description('Ponte MCP do Supremo para agentes de IA')
  .version('2.0.0')

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
  .option('--start', 'Inicia o dev server ao final')
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
  .command('mcp', { isDefault: true })
  .description('Roda a ponte MCP (o cliente chama isto automaticamente)')
  .action(async () => {
    await import('./index')
  })

program.parse()
