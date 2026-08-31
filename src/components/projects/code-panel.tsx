'use client'

import { useEffect, useState } from 'react'
import { FileCode, Folder, Loader2, Copy, Check } from 'lucide-react'
import { getRepoTree, getFileContent } from '@/actions/code'
import { cn } from '@/lib/utils'

/**
 * A aba de código: árvore de arquivos + conteúdo, dentro do Supremo.
 *
 * Read-only de propósito. Dado a aba do Banco edita direto porque teste não
 * prova valor de linha; código é o que os testes provam, então editar continua
 * pelo agente e pelos gates. Ver, aqui; mudar, pelo fluxo seguro.
 */
export function CodePanel({ projectId }: { projectId: string }) {
  const [files, setFiles] = useState<string[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)

  useEffect(() => {
    getRepoTree(projectId).then((result) => {
      if (result.error) setError(result.error)
      else {
        setFiles(result.files ?? [])
        // Abre a home por padrão, se existir.
        const first =
          result.files?.find((f) => f === 'app/page.tsx') ??
          result.files?.[0] ??
          null
        setSelected(first)
      }
    })
  }, [projectId])

  if (error) {
    return (
      <div className="bg-surface flex h-full items-center justify-center rounded-[var(--radius-inner)] p-8 text-center">
        <p className="text-muted max-w-sm text-sm">{error}</p>
      </div>
    )
  }
  if (!files) {
    return (
      <div className="bg-surface flex h-full items-center justify-center rounded-[var(--radius-inner)]">
        <Loader2 className="text-muted h-6 w-6 animate-spin" />
      </div>
    )
  }

  return (
    <div className="bg-surface flex h-full min-h-0 overflow-hidden rounded-[var(--radius-inner)]">
      {/* Árvore de arquivos */}
      <div className="w-64 shrink-0 overflow-y-auto p-2">
        <ul className="space-y-0.5">
          {files.map((path) => {
            const on = selected === path
            const depth = path.split('/').length - 1
            return (
              <li key={path}>
                <button
                  onClick={() => setSelected(path)}
                  style={{ paddingLeft: `${depth * 10 + 8}px` }}
                  className={cn(
                    'flex w-full items-center gap-1.5 rounded-[var(--radius-control)] py-1 pr-2 text-left text-xs transition-colors',
                    on ? 'bg-accent text-accent-ink' : 'text-ink hover:bg-sunken',
                  )}
                >
                  <FileCode className="h-3.5 w-3.5 shrink-0 opacity-70" />
                  <span className="truncate">{path.split('/').pop()}</span>
                </button>
              </li>
            )
          })}
        </ul>
      </div>

      {/* Conteúdo */}
      <div className="bg-sunken min-w-0 flex-1 overflow-hidden">
        {selected ? (
          <FileView key={selected} projectId={projectId} path={selected} />
        ) : (
          <div className="text-muted flex h-full items-center justify-center text-sm">
            Escolha um arquivo.
          </div>
        )}
      </div>
    </div>
  )
}

function FileView({
  projectId,
  path,
}: {
  projectId: string
  path: string
}) {
  const [content, setContent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let active = true
    getFileContent(projectId, path).then((result) => {
      if (!active) return
      if (result.error) setError(result.error)
      else setContent(result.content ?? '')
    })
    return () => {
      active = false
    }
  }, [projectId, path])

  async function copy() {
    if (content === null) return
    try {
      await navigator.clipboard.writeText(content)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // clipboard bloqueado — o conteúdo segue visível
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 px-4 py-2.5">
        <Folder className="text-muted h-3.5 w-3.5 shrink-0" />
        <span className="text-muted truncate font-mono text-xs">{path}</span>
        {content !== null && (
          <button
            onClick={copy}
            title="Copiar o arquivo"
            className="text-muted hover:text-ink ml-auto shrink-0"
          >
            {copied ? (
              <Check className="h-3.5 w-3.5" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-4 pb-4">
        {error ? (
          <p className="text-down-ink text-sm">{error}</p>
        ) : content === null ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="text-muted h-5 w-5 animate-spin" />
          </div>
        ) : (
          <pre className="text-ink font-mono text-xs leading-relaxed whitespace-pre">
            {content}
          </pre>
        )}
      </div>
    </div>
  )
}
