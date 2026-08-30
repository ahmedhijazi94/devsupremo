'use client'

import { useEffect, useState, useRef, Suspense } from 'react'
import { WebContainer } from '@webcontainer/api'
import { fetchGithubProjectTree } from '@/actions/github-tree'
import { getProjectEnvVars } from '@/actions/env-vars'
import { getLatestCommitSha, getChangedFilesContent } from '@/actions/github-sync'
import { useSearchParams } from 'next/navigation'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

let webcontainerInstance: WebContainer | null = null
let bootPromise: Promise<WebContainer> | null = null

type Stage = 'init' | 'fetching' | 'booting' | 'installing' | 'starting' | 'ready' | 'error'

const STAGE_LABELS: Record<Stage, string> = {
  init: 'Inicializando...',
  fetching: 'Buscando código no GitHub...',
  booting: 'Iniciando Máquina Virtual...',
  installing: 'Instalando dependências (npm install)...',
  starting: 'Iniciando servidor Next.js...',
  ready: '✅ Servidor online — HMR ativo',
  error: '❌ Erro',
}

const STAGE_COLORS: Record<Stage, string> = {
  init: 'text-zinc-400',
  fetching: 'text-blue-400',
  booting: 'text-violet-400',
  installing: 'text-amber-400',
  starting: 'text-cyan-400',
  ready: 'text-emerald-400',
  error: 'text-red-400',
}

function SandboxContent() {
  const searchParams = useSearchParams()
  const projectId = searchParams.get('projectId')

  const [url, setUrl] = useState<string | null>(null)
  const [stage, setStage] = useState<Stage>('init')
  const [error, setError] = useState<string | null>(null)
  const [showTerminal, setShowTerminal] = useState(true)

  const currentSha = useRef<string | null>(null)
  const isSyncing = useRef(false)
  const terminalRef = useRef<HTMLDivElement>(null)
  const terminal = useRef<Terminal | null>(null)
  const syncTimer = useRef<ReturnType<typeof setInterval> | null>(null)

  const log = (msg: string, color = '34') => {
    terminal.current?.writeln(`\x1b[1;${color}m[Supremo]\x1b[0m ${msg}`)
  }

  useEffect(() => {
    if (!projectId) return

    async function boot() {
      try {
        // Init terminal
        if (!terminal.current && terminalRef.current) {
          terminal.current = new Terminal({
            convertEol: true,
            fontSize: 12,
            fontFamily: 'JetBrains Mono, Menlo, monospace',
            theme: {
              background: '#09090b',
              foreground: '#e4e4e7',
              cursor: '#10b981',
            },
          })
          const fitAddon = new FitAddon()
          terminal.current.loadAddon(fitAddon)
          terminal.current.open(terminalRef.current)
          fitAddon.fit()
        }

        // Step 1: Fetch code from GitHub
        setStage('fetching')
        log('Autenticando e buscando repositório no GitHub...')
        currentSha.current = await getLatestCommitSha(projectId!)
        const tree = await fetchGithubProjectTree(projectId!)
        log(`Código carregado: ${Object.keys(tree).length} arquivos/pastas`, '32')

        // Step 2: Inject .env.local
        const envContent = await getProjectEnvVars(projectId!)
        if (envContent) {
          tree['.env.local'] = { file: { contents: envContent } }
          log('Variáveis de ambiente injetadas ✓', '32')
        }

        // Step 3: Boot WebContainer
        setStage('booting')
        if (!webcontainerInstance) {
          if (!bootPromise) {
            log('Inicializando WebContainer (sandbox no navegador)...')
            bootPromise = WebContainer.boot()
          }
          webcontainerInstance = await bootPromise
        }
        log('Máquina virtual pronta ✓', '32')

        // Step 4: Mount filesystem
        log('Montando sistema de arquivos...')
        await webcontainerInstance.mount(tree)

        // Step 5: instalar dependências
        setStage('installing')

        async function runInstall(args: string[]): Promise<number> {
          const proc = await webcontainerInstance!.spawn('npm', args)
          proc.output.pipeTo(new WritableStream({ write(data) { terminal.current?.write(data) } }))
          return proc.exit
        }

        const startedAt = Date.now()
        const hasLockfile = 'package-lock.json' in tree

        // npm ci usa o lockfile e pula a fase de resolução, que é a parte
        // cara. O install sem lockfile resolvia a árvore inteira na rede a
        // cada boot do preview.
        let exitCode: number

        if (hasLockfile) {
          log('Instalando a partir do lockfile (npm ci)...')
          exitCode = await runInstall(['ci', '--no-audit', '--no-fund'])

          if (exitCode !== 0) {
            log('npm ci falhou — o lockfile pode estar dessincronizado. Resolvendo do zero...', '33')
            exitCode = await runInstall(['install', '--no-audit', '--no-fund', '--legacy-peer-deps'])
          }
        } else {
          log('Projeto sem lockfile — resolvendo dependências do zero...', '33')
          exitCode = await runInstall(['install', '--no-audit', '--no-fund', '--legacy-peer-deps'])
        }

        if (exitCode !== 0) {
          log('Tentando sem executar scripts de instalação...', '33')
          exitCode = await runInstall([
            'install', '--no-audit', '--no-fund', '--legacy-peer-deps', '--ignore-scripts',
          ])
        }

        if (exitCode !== 0) {
          throw new Error('Não foi possível instalar as dependências. Confira o package.json do projeto.')
        }

        const seconds = Math.round((Date.now() - startedAt) / 1000)
        log(`Dependências instaladas em ${seconds}s ✓`, '32')

        // Step 6: subir o servidor de desenvolvimento
        setStage('starting')

        // Turbopack, padrão do Next 16, é binário nativo e não roda dentro
        // do WebContainer. Projetos gerados pelo Supremo trazem um script
        // dedicado; nos demais, passamos a flag adiante.
        const packageJsonFile = tree['package.json']
        const packageJson =
          packageJsonFile && 'file' in packageJsonFile
            ? String(packageJsonFile.file.contents)
            : ''
        const hasPreviewScript = packageJson.includes('"dev:preview"')

        const devArgs = hasPreviewScript
          ? ['run', 'dev:preview']
          : ['run', 'dev', '--', '--webpack']

        log(`Iniciando servidor Next.js (${hasPreviewScript ? 'dev:preview' : 'webpack'})...`)
        const devProcess = await webcontainerInstance.spawn('npm', devArgs)
        devProcess.output.pipeTo(new WritableStream({ write(data) { terminal.current?.write(data) } }))

        webcontainerInstance.on('server-ready', (port, previewUrl) => {
          setStage('ready')
          log('✅ Servidor online! HMR ativo — Detectando commits em tempo real.', '32')
          setUrl(previewUrl)
          setShowTerminal(false)

          // Polling de HMR. 3s batia na API do GitHub 1200x por hora por aba
          // aberta; 5s continua imperceptível e cabe no rate limit.
          syncTimer.current = setInterval(async () => {
            if (isSyncing.current || !currentSha.current || !webcontainerInstance) return
            isSyncing.current = true
            try {
              const latestSha = await getLatestCommitSha(projectId!)
              if (latestSha !== currentSha.current) {
                terminal.current?.writeln('\x1b[1;33m[HMR]\x1b[0m Novo commit detectado! Sincronizando...')
                const changedFiles = await getChangedFilesContent(projectId!, currentSha.current, latestSha)
                for (const file of changedFiles) {
                  if (file.status === 'removed') {
                    await webcontainerInstance.fs.rm(file.path, { force: true })
                    terminal.current?.writeln('\x1b[1;31m[HMR]\x1b[0m ✗ Removeu: ' + file.path)
                  } else if (file.content !== null) {
                    const dir = file.path.split('/').slice(0, -1).join('/')
                    if (dir) await webcontainerInstance.fs.mkdir(dir, { recursive: true })
                    await webcontainerInstance.fs.writeFile(file.path, file.content)
                    terminal.current?.writeln('\x1b[1;32m[HMR]\x1b[0m ✓ Atualizou: ' + file.path)
                  }
                }
                currentSha.current = latestSha
              }
            } catch (e) {
              console.error('HMR Sync Error:', e)
            } finally {
              isSyncing.current = false
            }
          }, 5000)
        })

      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        setStage('error')
        setError(message)
        log(`ERRO: ${message}`, '31')
      }
    }

    boot()

    return () => {
      if (syncTimer.current) {
        clearInterval(syncTimer.current)
        syncTimer.current = null
      }
    }
  }, [projectId])

  if (!projectId) return (
    <div className="flex h-screen items-center justify-center bg-zinc-950 text-zinc-400">
      ID do projeto não fornecido.
    </div>
  )

  return (
    <div className="flex flex-col h-screen w-full bg-zinc-950">
      {/* Status bar */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-zinc-800 bg-zinc-900 shrink-0">
        <div className={`flex items-center gap-2 text-xs font-mono ${STAGE_COLORS[stage]}`}>
          {stage !== 'ready' && stage !== 'error' && (
            <span className="inline-block w-2 h-2 rounded-full bg-current animate-pulse" />
          )}
          {stage === 'ready' && <span className="inline-block w-2 h-2 rounded-full bg-emerald-400" />}
          {stage === 'error' && <span className="inline-block w-2 h-2 rounded-full bg-red-500" />}
          {STAGE_LABELS[stage]}
        </div>
        {url && (
          <button
            onClick={() => setShowTerminal(v => !v)}
            className="ml-auto text-xs text-zinc-500 hover:text-zinc-300 transition-colors px-2 py-1 rounded border border-zinc-700 hover:border-zinc-500"
          >
            {showTerminal ? 'Ocultar Terminal' : 'Ver Terminal'}
          </button>
        )}
      </div>

      {/* Main area */}
      <div className="flex flex-1 overflow-hidden">
        {/* Preview iframe */}
        {url && !showTerminal && (
          <iframe
            src={url}
            className="flex-1 w-full h-full border-none bg-white"
            allow="accelerometer; ambient-light-sensor; camera; encrypted-media; geolocation; gyroscope; hid; microphone; midi; payment; usb; vr; xr-spatial-tracking"
            sandbox="allow-forms allow-modals allow-popups allow-presentation allow-same-origin allow-scripts"
          />
        )}

        {/* Terminal */}
        <div className={`flex flex-col bg-zinc-950 ${url && !showTerminal ? 'hidden' : 'flex-1'}`}>
          {stage === 'error' && error && (
            <div className="m-4 p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-xs font-mono">
              <p className="font-bold mb-1">❌ Erro durante o boot:</p>
              <p>{error}</p>
              <button
                onClick={() => { window.location.reload() }}
                className="mt-2 px-3 py-1 bg-red-500/20 hover:bg-red-500/30 rounded border border-red-500/40 transition-colors"
              >
                Tentar novamente
              </button>
            </div>
          )}
          <div ref={terminalRef} className="flex-1 p-2 overflow-hidden" />
        </div>
      </div>
    </div>
  )
}

export default function SandboxPage() {
  return (
    <Suspense fallback={
      <div className="flex h-screen items-center justify-center bg-zinc-950 text-zinc-400 text-sm font-mono">
        Carregando sandbox...
      </div>
    }>
      <SandboxContent />
    </Suspense>
  )
}
