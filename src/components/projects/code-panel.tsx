'use client'

import { useEffect, useState } from 'react'
import {
  FileCode,
  Folder,
  Loader2,
  Copy,
  Check,
  Pencil,
  GitPullRequest,
  X,
} from 'lucide-react'
import {
  getRepoTree,
  getFileContent,
  proposeFileEdit,
  type ProposeEditResult,
} from '@/actions/code'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'

/**
 * A aba de código: árvore de arquivos + conteúdo, dentro do Supremo.
 *
 * Ler é direto. Editar não escreve na base — abre um PR pelos mesmos gates do
 * agente. Dado a aba do Banco muda na hora porque teste não prova valor de
 * linha; código é o que os testes provam, então toda edição passa pelos gates.
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
  // Edição: draft !== null significa que estamos editando.
  const [draft, setDraft] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [pr, setPr] = useState<ProposeEditResult | null>(null)

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

  const editing = draft !== null

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

  async function propose() {
    if (draft === null) return
    setBusy(true)
    const res = await proposeFileEdit({ projectId, path, content: draft })
    setBusy(false)
    if (res.error) {
      toast.error(res.error)
      return
    }
    if (res.result) {
      setContent(draft) // a base ainda é a antiga até o merge, mas mostra o novo
      setDraft(null)
      setPr(res.result)
      toast.success('PR de edição aberto.')
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 px-4 py-2.5">
        <Folder className="text-muted h-3.5 w-3.5 shrink-0" />
        <span className="text-muted truncate font-mono text-xs">{path}</span>
        <div className="ml-auto flex shrink-0 items-center gap-3">
          {content !== null && !editing && (
            <>
              <button
                onClick={copy}
                title="Copiar o arquivo"
                className="text-muted hover:text-ink"
              >
                {copied ? (
                  <Check className="h-3.5 w-3.5" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
              </button>
              <button
                onClick={() => {
                  setPr(null)
                  setDraft(content)
                }}
                className="text-muted hover:text-ink inline-flex items-center gap-1 text-xs font-medium"
              >
                <Pencil className="h-3.5 w-3.5" /> Editar
              </button>
            </>
          )}
          {editing && (
            <>
              <button
                onClick={() => setDraft(null)}
                disabled={busy}
                className="text-muted hover:text-ink inline-flex items-center gap-1 text-xs font-medium"
              >
                <X className="h-3.5 w-3.5" /> Cancelar
              </button>
              <button
                onClick={propose}
                disabled={busy}
                className="bg-accent text-accent-ink inline-flex items-center gap-1.5 rounded-[var(--radius-control)] px-2.5 py-1 text-xs font-medium disabled:opacity-60"
              >
                {busy ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <GitPullRequest className="h-3.5 w-3.5" />
                )}
                Propor mudança
              </button>
            </>
          )}
        </div>
      </div>

      {pr && !editing && (
        <div className="text-muted bg-sunken mx-4 mb-2 flex items-center gap-2 rounded-[var(--radius-control)] px-3 py-2 text-xs">
          <GitPullRequest className="text-up-ink h-3.5 w-3.5 shrink-0" />
          PR #{pr.prNumber} aberto — os gates estão rodando.
          <a
            href={pr.prUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent font-medium hover:underline"
          >
            Abrir no GitHub
          </a>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto px-4 pb-4">
        {error ? (
          <p className="text-down-ink text-sm">{error}</p>
        ) : content === null ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="text-muted h-5 w-5 animate-spin" />
          </div>
        ) : editing ? (
          <textarea
            value={draft}
            disabled={busy}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
            className="bg-surface text-ink h-full w-full resize-none rounded-[var(--radius-control)] p-3 font-mono text-xs leading-relaxed outline-none"
          />
        ) : (
          <pre className="text-ink font-mono text-xs leading-relaxed whitespace-pre">
            {content}
          </pre>
        )}
      </div>
    </div>
  )
}
