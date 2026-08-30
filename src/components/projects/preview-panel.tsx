'use client'

import { useCallback, useEffect, useRef, useState, useTransition } from 'react'
import {
  Monitor,
  Tablet,
  Smartphone,
  RefreshCw,
  Rocket,
  ExternalLink,
  Code2,
  Link2,
  Check,
  TriangleAlert,
  Loader2,
  CloudOff,
} from 'lucide-react'
import { getPreviewState, type PreviewState } from '@/actions/vercel'
import { publishPreview } from '@/actions/preview'
import { cn } from '@/lib/utils'

interface PreviewPanelProps {
  projectId: string
  repoFullName: string | null
}

type Device = 'desktop' | 'tablet' | 'mobile'

const DEVICES: Array<{
  id: Device
  icon: typeof Monitor
  label: string
  width: string
}> = [
  { id: 'desktop', icon: Monitor, label: 'Desktop', width: '100%' },
  { id: 'tablet', icon: Tablet, label: 'Tablet', width: '768px' },
  { id: 'mobile', icon: Smartphone, label: 'Celular', width: '390px' },
]

/** Enquanto publica, vale perguntar de novo; parado, não. */
const POLL_MS = 6000

export function PreviewPanel({ projectId, repoFullName }: PreviewPanelProps) {
  const [state, setState] = useState<PreviewState | null>(null)
  const [device, setDevice] = useState<Device>('desktop')
  const [frameKey, setFrameKey] = useState(0)
  const [copied, setCopied] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [, startTransition] = useTransition()
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const load = useCallback(() => {
    startTransition(async () => {
      setState(await getPreviewState(projectId))
    })
  }, [projectId])

  useEffect(() => {
    load()
  }, [load])

  // Só continuamos perguntando enquanto há build em andamento.
  useEffect(() => {
    if (state?.status !== 'building') return

    timer.current = setTimeout(load, POLL_MS)
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [state?.status, load])

  async function copyLink() {
    if (!state?.url) return
    try {
      await navigator.clipboard.writeText(state.url)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Área de transferência bloqueada — o link segue visível no botão Abrir.
    }
  }

  function publish() {
    setPublishing(true)
    startTransition(async () => {
      const result = await publishPreview(projectId)
      setPublishing(false)

      if (result.error) {
        setState({ status: 'error', message: result.error })
        return
      }

      load()
    })
  }

  const deviceConfig = DEVICES.find((d) => d.id === device) ?? DEVICES[0]!
  const showFrame = state?.status === 'ready' && state.url

  return (
    <section className="bg-sunken flex h-full flex-col overflow-hidden rounded-[var(--radius-inner)]">
      {/* Barra de ferramentas */}
      <header className="flex shrink-0 flex-wrap items-center gap-3 px-3 py-2.5">
        <div className="bg-surface flex rounded-[var(--radius-control)] p-0.5">
          {DEVICES.map((option) => (
            <button
              key={option.id}
              onClick={() => setDevice(option.id)}
              title={option.label}
              aria-pressed={device === option.id}
              className={cn(
                'rounded-md p-1.5 transition-colors',
                device === option.id
                  ? 'bg-sunken text-ink'
                  : 'text-muted hover:text-ink',
              )}
            >
              <option.icon className="h-4 w-4" />
            </button>
          ))}
        </div>

        <button
          onClick={() => {
            setFrameKey((k) => k + 1)
            load()
          }}
          title="Recarregar"
          className="bg-surface text-muted hover:text-ink rounded-[var(--radius-control)] p-1.5 transition-colors"
        >
          <RefreshCw className="h-4 w-4" />
        </button>

        <StatusPill state={state} />

        <div className="ml-auto flex items-center gap-1.5">
          <button
            onClick={publish}
            disabled={publishing}
            title="Publicar o estado atual do repositório"
            className="bg-surface hover:text-ink inline-flex items-center gap-1.5 rounded-[var(--radius-control)] px-2.5 py-1.5 text-xs font-medium transition-colors disabled:opacity-50"
          >
            {publishing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Rocket className="h-3.5 w-3.5" />
            )}
            {publishing ? 'Publicando' : 'Publicar'}
          </button>

          {state?.url && (
            <button
              onClick={copyLink}
              className="bg-surface text-muted hover:text-ink inline-flex items-center gap-1.5 rounded-[var(--radius-control)] px-2.5 py-1.5 text-xs font-medium transition-colors"
            >
              {copied ? (
                <>
                  <Check className="h-3.5 w-3.5" />
                  Copiado
                </>
              ) : (
                <>
                  <Link2 className="h-3.5 w-3.5" />
                  Copiar link
                </>
              )}
            </button>
          )}

          {repoFullName && (
            <a
              href={`https://github.com/${repoFullName}`}
              target="_blank"
              rel="noopener noreferrer"
              className="bg-surface text-muted hover:text-ink inline-flex items-center gap-1.5 rounded-[var(--radius-control)] px-2.5 py-1.5 text-xs font-medium transition-colors"
            >
              <Code2 className="h-3.5 w-3.5" />
              Código
            </a>
          )}

          {state?.url && (
            <a
              href={state.url}
              target="_blank"
              rel="noopener noreferrer"
              className="bg-surface text-muted hover:text-ink inline-flex items-center gap-1.5 rounded-[var(--radius-control)] px-2.5 py-1.5 text-xs font-medium transition-colors"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              Abrir
            </a>
          )}
        </div>
      </header>

      {/* Área do preview */}
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto px-3 pb-3">
        {showFrame ? (
          <div
            className="h-full max-h-full overflow-hidden rounded-[var(--radius-inner)] bg-white shadow-lg transition-[width] duration-300"
            style={{ width: deviceConfig.width, maxWidth: '100%' }}
          >
            <iframe
              key={frameKey}
              src={state.url}
              title="Preview do projeto"
              className="h-full w-full border-0"
              sandbox="allow-forms allow-modals allow-popups allow-same-origin allow-scripts"
            />
          </div>
        ) : (
          <EmptyState state={state} />
        )}
      </div>
    </section>
  )
}

function StatusPill({ state }: { state: PreviewState | null }) {
  if (!state) {
    return (
      <span className="text-muted inline-flex items-center gap-1.5 text-xs">
        <Loader2 className="h-3 w-3 animate-spin" />
        Verificando
      </span>
    )
  }

  const config = {
    ready: { dot: 'bg-up-ink', label: 'No ar', pulse: false },
    building: { dot: 'bg-wait-ink', label: 'Publicando', pulse: true },
    error: { dot: 'bg-down-ink', label: 'Falhou', pulse: false },
    no_deployment: {
      dot: 'bg-line-strong',
      label: 'Sem deploy',
      pulse: false,
    },
    not_connected: {
      dot: 'bg-line-strong',
      label: 'Não conectado',
      pulse: false,
    },
  }[state.status]

  return (
    <span className="inline-flex items-center gap-2 text-xs font-medium">
      <span
        className={cn(
          'h-2 w-2 rounded-full',
          config.dot,
          config.pulse && 'animate-pulse',
        )}
      />
      {config.label}
      {state.branch && (
        <code className="bg-sunken text-muted rounded px-1.5 py-0.5 font-mono text-[11px]">
          {state.branch}
        </code>
      )}
    </span>
  )
}

function EmptyState({ state }: { state: PreviewState | null }) {
  if (!state) {
    return (
      <div className="text-muted flex flex-col items-center gap-3">
        <Loader2 className="h-5 w-5 animate-spin" />
        <p className="text-sm">Consultando a Vercel…</p>
      </div>
    )
  }

  const Icon =
    state.status === 'building'
      ? Loader2
      : state.status === 'error'
        ? TriangleAlert
        : CloudOff

  return (
    <div className="mx-auto max-w-sm text-center">
      <Icon
        className={cn(
          'mx-auto mb-3 h-6 w-6',
          state.status === 'building' && 'text-wait-ink animate-spin',
          state.status === 'error' && 'text-down-ink',
          (state.status === 'not_connected' ||
            state.status === 'no_deployment') &&
            'text-muted',
        )}
      />
      <p className="text-sm font-medium">
        {state.status === 'building' && 'Publicando o preview'}
        {state.status === 'error' && 'O build falhou'}
        {state.status === 'no_deployment' && 'Nenhum deploy ainda'}
        {state.status === 'not_connected' && 'Preview não configurado'}
      </p>
      {state.message && (
        <p className="text-muted mt-1.5 text-sm">{state.message}</p>
      )}
      {state.inspectorUrl && (
        <a
          href={state.inspectorUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-ink mt-3 inline-flex items-center gap-1.5 text-xs font-medium hover:underline"
        >
          Ver logs na Vercel
          <ExternalLink className="h-3 w-3" />
        </a>
      )}
    </div>
  )
}
