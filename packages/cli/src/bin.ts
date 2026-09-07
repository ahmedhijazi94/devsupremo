#!/usr/bin/env node
import { Command } from 'commander'
// Fonte ÚNICA da versão: o próprio package.json (o esbuild inlina no bundle, e o
// prepublishOnly reconstrói antes de publicar). Assim `--version` nunca diverge da
// versão publicada.
import pkg from '../package.json'
import { isKnownOrGlobal, unknownCommandMessage } from './command-guard'

const program = new Command()

program
  .name('supremo')
  .description('CLI do Supremo (bootstrap, checkpoints e desenvolvimento local)')
  .version(pkg.version)

/** Rejeita comandos desconhecidos antes de executar qualquer operação. */
function guardUnknownCommand(argv: string[]): void {
  const first = argv[0]
  if (isKnownOrGlobal(first)) return
  console.error(unknownCommandMessage(first!))
  process.exit(1)
}

program
  .command('turn <event>')
  .description('Protocolo executável de turnos e validação em background')
  .option('--host <name>', 'Host que entregou o evento', 'assisted')
  .action(async (event: string, options: { host: string }) => {
    const { runTurnEvent } = await import('./turn-runtime')
    const fs = await import('node:fs')
    try {
      const raw = process.stdin.isTTY ? '' : fs.readFileSync(0, 'utf8')
      const output = await runTurnEvent(event, process.cwd(), raw.trim() ? JSON.parse(raw) as unknown : {}, options.host)
      console.log(JSON.stringify(output))
    } catch (error) {
      const { sanitizeDiagnostic } = await import('../../../src/lib/checkpoint/feedback')
      console.log(JSON.stringify({ protocolVersion: 1, workerAvailable: true, allowed: false,
        reason: sanitizeDiagnostic(error instanceof Error ? error.message : String(error)) }))
      process.exitCode = 1
    }
  })

program
  .command('host <event>')
  .description('Instala ou verifica adapters de lifecycle')
  .action(async (event: string) => {
    const adapter = await import('./host-adapters')
    if (event !== 'install' && event !== 'status') throw new Error('Use host install ou host status.')
    console.log(JSON.stringify(event === 'install' ? adapter.installHostAdapters(process.cwd()) : adapter.inspectHostAdapters(process.cwd())))
  })

program
  .command('bootstrap <project-id>')
  .description('Prepara o workspace local do projeto (autoriza no navegador)')
  .requiredOption('-u, --url <url>', 'URL do Supremo, ex.: https://supremo.app')
  .option('-d, --dir <dir>', 'Pasta-base onde criar o projeto (padrão: pasta atual)')
  .option('--host <name>', 'Agente usado no projeto: claude-code ou codex', 'claude-code')
  .option('--start', '(sem efeito — preview e daemon já sobem sempre; aceito por compatibilidade)')
  .action(
    async (
      projectId: string,
      options: { url: string; dir?: string; start?: boolean; host: string },
    ) => {
      const { runBootstrap } = await import('./bootstrap')
      try {
        if (options.host !== 'claude-code' && options.host !== 'codex') throw new Error('Host inválido: use claude-code ou codex.')
        await runBootstrap({
          projectId,
          url: options.url,
          ...(options.dir === undefined ? {} : { dir: options.dir }),
          ...(options.start === undefined ? {} : { start: options.start }),
          host: options.host,
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
      // v3.3: a base declarada (parentCheckpointId) considera também o último
      // estado remoto CONFIRMADAMENTE sincronizado (ver sync.ts) — numa
      // máquina recém-sincronizada a fila local sozinha ainda não sabe que a
      // base avançou. Só leitura de arquivo — nenhuma rede aqui.
      const { resolveParentCheckpointId, readSyncedRemoteState } = await import('./sync')
      const deps = defaultCheckpointDeps(cwd)
      const parentCheckpointIdOverride = resolveParentCheckpointId(
        deps.readQueue(),
        readSyncedRemoteState(cwd),
      )
      const record = runCheckpoint(summary, projectId, deps, {
        ...(options.conversationId === undefined ? {} : { conversationId: options.conversationId }),
        ...(options.messageId === undefined ? {} : { messageId: options.messageId }),
        ...(options.originAgent === undefined ? {} : { originAgent: options.originAgent }),
        parentCheckpointIdOverride,
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
        const keychainModule = await import('./keychain')
        const kc = keychainModule.resolveKeychain()
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
  .command('sync')
  .description(
    'Sincronização entre máquinas: religa a este worktree ao checkpoint mais ' +
      'recente conhecido do projeto (fast-forward seguro se possível). Rode UMA ' +
      'vez no primeiro pedido da sessão, depois de `daemon --ensure`/preview.',
  )
  .action(async () => {
    const cwd = process.cwd()
    const [{ readProjectId, defaultCheckpointDeps }, daemon, sync] = await Promise.all([
      import('./checkpoint'),
      import('./daemon'),
      import('./sync'),
    ])
    const projectId = readProjectId(cwd)
    const cfg = daemon.readProjectConfig(cwd)
    if (!projectId || !cfg) {
      // Sem bootstrap ainda: não há o que sincronizar. Nunca um erro — é só
      // um no-op silencioso (o próprio bootstrap deixa tudo em dia).
      console.log(
        JSON.stringify({
          action: 'up_to_date',
          message: 'projeto ainda não inicializado — nada a sincronizar.',
        }),
      )
      return
    }
    const keychainModule = await import('./keychain')
    const kc = keychainModule.resolveKeychain()
    const deviceSecret = kc.get(cfg.projectId)
    const http = daemon.defaultDaemonHttp(cfg.apiBaseUrl)

    const outcome = await sync.runSync(
      sync.defaultSyncDeps(defaultCheckpointDeps(cwd), cwd, async () => {
        if (!deviceSecret) return { ok: false } // sem device: segue local, nunca trava
        try {
          const result = await http.syncStatus({ deviceSecret, projectId: cfg.projectId })
          return { ok: true, latest: result.latest }
        } catch {
          // Timeout/rede/auth — tudo vira "não deu pra saber" (ver DaemonHttp.syncStatus).
          return { ok: false }
        }
      }),
    )
    console.log(JSON.stringify({ action: outcome.action.kind, message: outcome.message }))
  })

program
  .command('db <operation>')
  .description('Banco development: status, migrate ou anonymous-auth (autoridade do servidor)')
  .action(async (operation: string) => {
    try {
      if (operation !== 'status' && operation !== 'migrate' && operation !== 'anonymous-auth') {
        throw new Error('Use db status, db migrate ou db anonymous-auth.')
      }
      const database = await import('./database')
      console.log(JSON.stringify(await database.runDatabase(operation)))
    } catch (error) {
      console.error(error instanceof Error ? error.message : 'Falha ao acessar o banco.')
      process.exitCode = 1
    }
  })

guardUnknownCommand(process.argv.slice(2))
if (process.argv.length === 2) program.outputHelp()
else program.parse()
