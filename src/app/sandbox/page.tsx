'use client'

import { useEffect, useState, useRef } from 'react'
import { WebContainer } from '@webcontainer/api'
import { fetchGithubProjectTree } from '@/actions/github-tree'
import { getLatestCommitSha, getChangedFilesContent } from '@/actions/github-sync'
import { useSearchParams } from 'next/navigation'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'


let webcontainerInstance: WebContainer | null = null
let bootPromise: Promise<WebContainer> | null = null


import { Suspense } from 'react'

function SandboxContent() {
  const searchParams = useSearchParams()
  const projectId = searchParams.get('projectId')
  
  const [url, setUrl] = useState<string | null>(null)
  const currentSha = useRef<string | null>(null)
  const isSyncing = useRef(false)

  const [status, setStatus] = useState('Inicializando Motor WebContainer...')
  const [error, setError] = useState<string | null>(null)
  
  const terminalRef = useRef<HTMLDivElement>(null)
  const terminal = useRef<Terminal | null>(null)

  useEffect(() => {
    if (!projectId) return

    async function boot() {
      try {
        if (!terminal.current && terminalRef.current) {
          terminal.current = new Terminal({ convertEol: true, fontSize: 12 })
          const fitAddon = new FitAddon()
          terminal.current.loadAddon(fitAddon)
          terminal.current.open(terminalRef.current)
          fitAddon.fit()
        }

        const log = (msg: string) => {
          setStatus(msg)
          terminal.current?.writeln(`\x1b[1;34m[Supremo]\x1b[0m ${msg}`)
        }


        log('Conectando ao GitHub (Buscando código seguro)...')
        currentSha.current = await getLatestCommitSha(projectId!)
        const tree = await fetchGithubProjectTree(projectId!)

        

        if (!webcontainerInstance) {
          if (!bootPromise) {
            log('Iniciando Máquina Virtual no Navegador...')
            bootPromise = WebContainer.boot()
          } else {
            log('Aguardando inicialização prévia...')
          }
          webcontainerInstance = await bootPromise
        }

        
        log(`Montando sistema de arquivos (${Object.keys(tree).length} root items)...`)
        await webcontainerInstance.mount(tree)
        
        log('Instalando dependências (npm install)...')
        const installProcess = await webcontainerInstance.spawn('npm', ['install', '--no-package-lock', '--legacy-peer-deps'])
        
        installProcess.output.pipeTo(new WritableStream({
          write(data) {
            terminal.current?.write(data)
          }
        }))
        
        const installExitCode = await installProcess.exit
        if (installExitCode !== 0) throw new Error('Falha no npm install')
        
        log('Iniciando Servidor Next.js (npm run dev)...')
        const devProcess = await webcontainerInstance.spawn('npm', ['run', 'dev'])
        devProcess.output.pipeTo(new WritableStream({
          write(data) {
            terminal.current?.write(data)
          }
        }))
        

        webcontainerInstance.on('server-ready', (port, previewUrl) => {
          log('✅ Servidor Online! HMR Ativado.')
          setUrl(previewUrl)
          
          // Iniciar HMR Polling
          setInterval(async () => {
            if (isSyncing.current || !currentSha.current || !webcontainerInstance) return
            isSyncing.current = true
            try {
              const latestSha = await getLatestCommitSha(projectId!)
              if (latestSha !== currentSha.current) {
                terminal.current?.writeln('\x1b[1;33m[Supremo HMR]\x1b[0m Detectado novo commit. Sincronizando...')
                const changedFiles = await getChangedFilesContent(projectId!, currentSha.current, latestSha)
                
                for (const file of changedFiles) {
                  if (file.status === 'removed') {
                    await webcontainerInstance.fs.rm(file.path, { force: true })
                    terminal.current?.writeln('\x1b[1;31m[Supremo HMR]\x1b[0m Apagou ' + file.path)
                  } else {
                    // Make sure directory exists
                    const dir = file.path.split('/').slice(0, -1).join('/')
                    if (dir) {
                      await webcontainerInstance.fs.mkdir(dir, { recursive: true })
                    }
                    await webcontainerInstance.fs.writeFile(file.path, file.content)
                    terminal.current?.writeln('\x1b[1;32m[Supremo HMR]\x1b[0m Atualizou ' + file.path)
                  }
                }
                currentSha.current = latestSha
              }
            } catch (e) {
              console.error('HMR Sync Error:', e)
            } finally {
              isSyncing.current = false
            }
          }, 3000)
        })


      } catch (err: any) {
        console.error(err)
        setError(err.message)
        terminal.current?.writeln(`\x1b[1;31m[Erro]\x1b[0m ${err.message}`)
      }
    }
    boot()
  }, [projectId])

  if (!projectId) return <div>ID do projeto não fornecido.</div>
  


  return (
    <div className="flex flex-col h-screen w-full bg-white">
      {!url && (
        <div className="flex flex-col flex-1 items-center justify-center bg-zinc-950 text-white font-mono text-sm">
          {error ? (
            <div className="mb-4 text-red-400 font-bold">❌ {error}</div>
          ) : (
            <div className="animate-pulse mb-4 text-emerald-400">⚡ {status}</div>
          )}
          <div className="w-full max-w-4xl h-96 bg-black rounded-xl border border-zinc-800 overflow-hidden p-2" ref={terminalRef} />
        </div>
      )}
      {url && (
        <iframe 
          src={url} 
          className="flex-1 w-full h-full border-none bg-white" 
          allow="accelerometer; ambient-light-sensor; camera; encrypted-media; geolocation; gyroscope; hid; microphone; midi; payment; usb; vr; xr-spatial-tracking"
          sandbox="allow-forms allow-modals allow-popups allow-presentation allow-same-origin allow-scripts"
        />
      )}
    </div>
  )
}


export default function SandboxPage() {
  return (
    <Suspense fallback={<div className="p-4">Loading Sandbox...</div>}>
      <SandboxContent />
    </Suspense>
  )
}
