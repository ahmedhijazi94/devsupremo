'use client'

import { useEffect, useState, useRef } from 'react'
import { WebContainer } from '@webcontainer/api'
import { fetchGithubProjectTree } from '@/actions/github-tree'
import { useSearchParams } from 'next/navigation'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

let webcontainerInstance: WebContainer | null = null

import { Suspense } from 'react'

function SandboxContent() {
  const searchParams = useSearchParams()
  const projectId = searchParams.get('projectId')
  const [url, setUrl] = useState<string | null>(null)
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
        const tree = await fetchGithubProjectTree(projectId!)
        
        if (!webcontainerInstance) {
          log('Iniciando Máquina Virtual no Navegador...')
          webcontainerInstance = await WebContainer.boot()
        }
        
        log('Montando sistema de arquivos...')
        await webcontainerInstance.mount(tree)
        
        log('Instalando dependências (npm install)...')
        const installProcess = await webcontainerInstance.spawn('npm', ['install'])
        
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
          log('✅ Servidor Online!')
          setUrl(previewUrl)
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
  
  if (error) return (
    <div className="flex flex-col h-full bg-red-50 text-red-600 p-8 font-mono text-sm">
      <h3 className="font-bold text-lg mb-2">Erro Crítico no Motor</h3>
      <p>{error}</p>
      <div ref={terminalRef} className="mt-4 flex-1 bg-black rounded-lg overflow-hidden p-2" />
    </div>
  )

  return (
    <div className="flex flex-col h-full w-full">
      {!url && (
        <div className="flex flex-col flex-1 items-center justify-center bg-zinc-950 text-white font-mono text-sm">
          <div className="animate-pulse mb-4 text-emerald-400">⚡ {status}</div>
          <div className="w-full max-w-2xl h-64 bg-black rounded-xl border border-zinc-800 overflow-hidden p-2" ref={terminalRef} />
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
