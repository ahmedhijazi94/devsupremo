'use client'

import { useState } from 'react'
import { Monitor, Smartphone, Tablet, ExternalLink, RefreshCw, Code2 } from 'lucide-react'

interface PreviewPanelProps {
  repoFullName: string
  projectId: string
}

type DeviceType = 'mobile' | 'tablet' | 'desktop'

export function PreviewPanel({ repoFullName, projectId }: PreviewPanelProps) {
  const [device, setDevice] = useState<DeviceType>('desktop')
  const [key, setKey] = useState(0)

  // Use StackBlitz for immediate in-browser WebContainer preview
  // It boots up Next.js instantly by reading the GitHub repo.
  const previewUrl = `/sandbox?projectId=${projectId}`
  const editorUrl = `https://github.com/${repoFullName}`

  const deviceStyles = {
    mobile: 'w-[375px] h-[667px]',
    tablet: 'w-[768px] h-[1024px]',
    desktop: 'w-full h-[600px]',
  }

  return (
    <div className="border bg-card rounded-xl overflow-hidden flex flex-col shadow-sm">
      {/* Toolbar */}
      <div className="h-12 border-b bg-muted/30 px-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="flex bg-background border rounded-lg p-1">
            <button
              onClick={() => setDevice('desktop')}
              className={`p-1.5 rounded-md transition-colors ${device === 'desktop' ? 'bg-muted shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
              title="Desktop"
            >
              <Monitor className="w-4 h-4" />
            </button>
            <button
              onClick={() => setDevice('tablet')}
              className={`p-1.5 rounded-md transition-colors ${device === 'tablet' ? 'bg-muted shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
              title="Tablet"
            >
              <Tablet className="w-4 h-4" />
            </button>
            <button
              onClick={() => setDevice('mobile')}
              className={`p-1.5 rounded-md transition-colors ${device === 'mobile' ? 'bg-muted shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
              title="Mobile"
            >
              <Smartphone className="w-4 h-4" />
            </button>
          </div>
          
          <button 
            onClick={() => setKey(k => k + 1)}
            className="p-1.5 ml-2 text-muted-foreground hover:text-foreground transition-colors"
            title="Recarregar Preview"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>

        <div className="flex items-center gap-2 text-sm font-medium">
          <span className="flex h-2 w-2 rounded-full bg-green-500 animate-pulse mr-2" />
          Live Preview
        </div>

        <div className="flex items-center gap-2">
          <a
            href={editorUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors bg-background border rounded-md px-3 py-1.5"
          >
            <Code2 className="w-3.5 h-3.5" />
            Código
          </a>
          <a
            href={previewUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors bg-background border rounded-md px-3 py-1.5"
          >
            <ExternalLink className="w-3.5 h-3.5" />
            Abrir
          </a>
        </div>
      </div>

      {/* Preview Area */}
      <div className="bg-zinc-100 dark:bg-zinc-950/50 p-4 flex items-center justify-center overflow-auto min-h-[400px]">
        <div 
          className={`bg-white transition-all duration-300 ease-in-out border shadow-lg rounded-md overflow-hidden ${deviceStyles[device]}`}
        >
          <iframe
            key={key}
            src={previewUrl}
            className="w-full h-full border-0"
            allow="accelerometer; ambient-light-sensor; camera; encrypted-media; geolocation; gyroscope; hid; microphone; midi; payment; usb; vr; xr-spatial-tracking"
            sandbox="allow-forms allow-modals allow-popups allow-presentation allow-same-origin allow-scripts"
          />
        </div>
      </div>
    </div>
  )
}
