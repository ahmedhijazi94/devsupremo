'use client'

import { useEffect, useRef, useState } from 'react'
import { Loader2, Play, ExternalLink, Square, Circle } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { parseEvent } from '@/lib/runtime/protocol'
import { startLocalPreview, stopLocalPreview } from '@/actions/local-preview'
import { cn } from '@/lib/utils'

/**
 * Preview local: o Next real roda no companion (na máquina do dev). Este painel
 * fala com o companion pelo canal Realtime PRIVADO do usuário — recebe status e
 * a URL do preview, e dispara start/stop via server action (o servidor valida e
 * transmite; o navegador nunca publica comando direto).
 *
 * Sem companion online, mostra como ligá-lo. O preview embutido pode esbarrar em
 * mixed-content (https embutindo localhost) — por isso há sempre "Abrir em aba".
 */
type Phase = 'offline' | 'preparing' | 'starting' | 'online' | 'error'

export function LocalPreviewPanel({ projectId }: { projectId: string }) {
  const [companionOnline, setCompanionOnline] = useState(false)
  const [phase, setPhase] = useState<Phase>('offline')
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [detail, setDetail] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // Embutir localhost num app https costuma ser bloqueado; por padrão mostramos
  // o botão "Abrir preview" (sempre funciona) e deixamos embutir sob demanda.
  const [embed, setEmbed] = useState(false)
  const channelRef = useRef<ReturnType<
    ReturnType<typeof createClient>['channel']
  > | null>(null)

  useEffect(() => {
    const supabase = createClient()
    let active = true

    supabase.auth.getUser().then(({ data }) => {
      const userId = data.user?.id
      if (!userId || !active) return

      // Canal privado do usuário — RLS garante que só ele entra.
      const channel = supabase.channel(`runtime:${userId}`, {
        config: { private: true, presence: { key: 'web' } },
      })
      channelRef.current = channel

      channel.on('broadcast', { event: 'event' }, ({ payload }) => {
        const evt = parseEvent(payload)
        if (!evt || !('projectId' in evt) || evt.projectId !== projectId) return
        if (evt.type === 'runtime_status') {
          setPhase(evt.status as Phase)
          setDetail(evt.detail ?? null)
          if (evt.previewUrl) setPreviewUrl(evt.previewUrl)
        } else if (evt.type === 'preview_ready') {
          setPhase('online')
          setPreviewUrl(evt.url)
        } else if (evt.type === 'error') {
          setPhase('error')
          setDetail(evt.message)
        }
      })

      channel.on('presence', { event: 'sync' }, () => {
        const state = channel.presenceState() as Record<string, unknown[]>
        // Companion presente = qualquer entrada com key 'companion'.
        setCompanionOnline(Boolean(state['companion']?.length))
      })

      channel.subscribe()
    })

    return () => {
      active = false
      if (channelRef.current) void channelRef.current.unsubscribe()
    }
  }, [projectId])

  async function start() {
    setBusy(true)
    setDetail(null)
    setPhase('preparing')
    const res = await startLocalPreview(projectId)
    setBusy(false)
    if (res.error) {
      setPhase('error')
      setDetail(res.error)
    }
  }

  async function stop() {
    setBusy(true)
    await stopLocalPreview(projectId)
    setBusy(false)
    setPhase('offline')
    setPreviewUrl(null)
  }

  return (
    <div className="bg-surface flex h-full min-h-0 flex-col overflow-hidden rounded-[var(--radius-inner)]">
      {/* Barra de status/controle */}
      <div className="flex flex-wrap items-center gap-3 px-4 py-2.5">
        <span
          className={cn(
            'inline-flex items-center gap-1.5 text-xs font-medium',
            companionOnline ? 'text-up-ink' : 'text-muted',
          )}
          title={companionOnline ? 'Companion conectado' : 'Companion offline'}
        >
          <Circle
            className={cn(
              'h-2.5 w-2.5',
              companionOnline ? 'fill-up-ink' : 'fill-muted',
            )}
          />
          Companion {companionOnline ? 'online' : 'offline'}
        </span>

        <span className="text-muted text-xs">·</span>
        <PhasePill phase={phase} />

        <div className="ml-auto flex items-center gap-2">
          {phase === 'online' && previewUrl && (
            <a
              href={previewUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-muted hover:text-ink inline-flex items-center gap-1 text-xs font-medium"
            >
              <ExternalLink className="h-3.5 w-3.5" /> Abrir em aba
            </a>
          )}
          {phase === 'online' ? (
            <button
              onClick={stop}
              disabled={busy}
              className="text-muted hover:text-down-ink inline-flex items-center gap-1.5 text-xs font-medium disabled:opacity-50"
            >
              <Square className="h-3.5 w-3.5" /> Parar
            </button>
          ) : (
            <button
              onClick={start}
              disabled={busy || !companionOnline}
              title={companionOnline ? '' : 'Ligue o companion primeiro'}
              className="bg-accent text-accent-ink inline-flex items-center gap-1.5 rounded-[var(--radius-control)] px-3 py-1.5 text-sm font-medium disabled:opacity-40"
            >
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Play className="h-4 w-4" />
              )}
              Iniciar preview local
            </button>
          )}
        </div>
      </div>

      {/* Corpo */}
      <div className="bg-sunken min-h-0 flex-1">
        {!companionOnline ? (
          <OfflineHelp />
        ) : phase === 'online' && previewUrl ? (
          embed ? (
            <iframe
              src={previewUrl}
              title="Preview local"
              className="h-full w-full border-0 bg-white"
            />
          ) : (
            <OnlineCard url={previewUrl} onEmbed={() => setEmbed(true)} />
          )
        ) : phase === 'error' ? (
          <div className="text-down-ink flex h-full items-center justify-center p-6 text-center text-sm">
            {detail ?? 'Falhou ao iniciar o preview local.'}
          </div>
        ) : phase === 'preparing' || phase === 'starting' ? (
          <div className="text-muted flex h-full flex-col items-center justify-center gap-2 text-sm">
            <Loader2 className="h-6 w-6 animate-spin" />
            {phase === 'preparing' ? 'Preparando o projeto…' : 'Subindo o Next…'}
          </div>
        ) : (
          <div className="text-muted flex h-full items-center justify-center text-sm">
            Clique em “Iniciar preview local”.
          </div>
        )}
      </div>
    </div>
  )
}

function OnlineCard({ url, onEmbed }: { url: string; onEmbed: () => void }) {
  return (
    <div className="text-muted mx-auto flex h-full max-w-md flex-col items-center justify-center gap-3 px-6 text-center">
      <p className="text-ink text-sm font-medium">Preview local no ar 🚀</p>
      <p className="font-mono text-xs">{url}</p>
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="bg-accent text-accent-ink inline-flex items-center gap-1.5 rounded-[var(--radius-control)] px-4 py-2 text-sm font-medium"
      >
        <ExternalLink className="h-4 w-4" /> Abrir preview
      </a>
      <p className="text-xs">
        Embutir aqui costuma ser bloqueado pelo navegador (https ↔ localhost).
        Abrir em aba sempre funciona.{' '}
        <button onClick={onEmbed} className="text-accent hover:underline">
          tentar embutir mesmo assim
        </button>
      </p>
    </div>
  )
}

function PhasePill({ phase }: { phase: Phase }) {
  const label = {
    offline: 'Parado',
    preparing: 'Preparando',
    starting: 'Subindo',
    online: 'No ar',
    error: 'Erro',
  }[phase]
  return <span className="text-muted text-xs">{label}</span>
}

function OfflineHelp() {
  return (
    <div className="text-muted mx-auto flex h-full max-w-md flex-col items-center justify-center gap-3 px-6 text-center text-sm">
      <p className="text-ink font-medium">Companion offline</p>
      <p>
        O preview local roda um dev server na sua máquina. É um arquivo só — não
        precisa clonar nada. Pegue o comando pronto (com o seu token já dentro)
        em <span className="text-ink font-medium">/mcps</span>, bloco “Preview
        local (companion)”, cole no Terminal e deixe rodando:
      </p>
      <pre className="bg-surface text-ink w-full overflow-x-auto rounded-[var(--radius-control)] p-3 text-left font-mono text-xs">
        curl -fsSL .../companion/supremo-runtime.mjs -o supremo-runtime.mjs
        {'\n'}node supremo-runtime.mjs login --url ... --token ...
        {'\n'}node supremo-runtime.mjs run
      </pre>
    </div>
  )
}
