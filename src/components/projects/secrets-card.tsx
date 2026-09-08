'use client'

import { useEffect, useState } from 'react'
import { KeyRound, Check, Loader2, X } from 'lucide-react'
import { getSecretRequests, saveSecret, dismissSecretRequest, type SecretRequestView } from '@/actions/secrets'
import { toast } from 'sonner'

const environments = { development: 'Desenvolvimento', preview: 'Preview', production: 'Produção' }
function destination(request: SecretRequestView): string {
  if (!request.target || !request.environment || !request.targetRef) return 'Pedido antigo sem destino confirmado. Dispense e peça ao agente para solicitar novamente.'
  return `${request.target === 'supabase' ? 'Supabase · Edge Functions' : 'Vercel'} · ${environments[request.environment]} · ${request.targetRef}`
}

export function SecretsCard({ projectId }: { projectId: string }) {
  const [requests, setRequests] = useState<SecretRequestView[]>([])
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    let active = true
    let fetching = false
    const refresh = async () => {
      if (fetching) return
      fetching = true
      try {
        const result = await getSecretRequests(projectId)
        if (!active) return
        if (result.error) setError(result.error)
        else { setRequests(result.requests ?? []); setError(null) }
      } catch { if (active) setError('Não foi possível atualizar os pedidos de chaves. Tente novamente.') }
      finally { fetching = false }
    }
    void refresh()
    const interval = window.setInterval(() => { if (document.visibilityState === 'visible') void refresh() }, 5000)
    window.addEventListener('focus', refresh)
    return () => { active = false; window.clearInterval(interval); window.removeEventListener('focus', refresh) }
  }, [projectId, nonce])
  if (!requests.length && !error) return null
  return (
    <section id="secrets" className="bg-surface rounded-[var(--radius-inner)] p-4">
      <div className="mb-1 flex items-center gap-2"><KeyRound className="text-accent h-4 w-4 shrink-0" /><h2 className="text-sm font-semibold">Chaves solicitadas pelo agente</h2></div>
      <p className="text-muted mb-3 text-xs">Cole cada chave aqui. O valor segue apenas para o destino indicado; não vai para o chat nem fica no histórico do Supremo.</p>
      {error && <div role="alert" className="mb-3 text-xs">{error} <button type="button" onClick={() => setNonce((n) => n + 1)} className="underline">Tentar novamente</button></div>}
      <ul className="space-y-3">{requests.map((request) => <li key={request.id}>
        {request.status === 'fulfilled' ? <div className="text-muted text-xs"><div className="flex items-center gap-2"><Check className="text-up-ink h-3.5 w-3.5" /><span className="font-mono">{request.name}</span><span>configurado</span></div><p className="mt-1 break-all">{destination(request)}</p></div>
          : <SecretForm projectId={projectId} request={request} onDone={() => setNonce((n) => n + 1)} />}
      </li>)}</ul>
    </section>
  )
}

function SecretForm({ projectId, request, onDone }: { projectId: string; request: SecretRequestView; onDone: () => void }) {
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const inputId = `secret-${request.id}`
  const configured = Boolean(request.target && request.environment && request.targetRef)
  async function save() {
    if (!value.trim() || busy) return
    setBusy(true)
    try {
      const result = await saveSecret({ projectId, requestId: request.id, value })
      if (result.error || !result.ok) { toast.error(result.error ?? 'Envio não confirmado.'); return }
      setValue('')
      toast.success(request.target === 'vercel' ? `${request.name} enviado. Disponível no próximo deploy desse ambiente.` : `${request.name} enviado às Edge Functions do projeto.`)
      onDone()
    } catch { toast.error('Não foi possível confirmar o envio. Tente novamente.') }
    finally { setBusy(false) }
  }
  async function dismiss() {
    if (busy) return
    setBusy(true)
    try {
      const result = await dismissSecretRequest({ projectId, requestId: request.id })
      if (result.error || !result.ok) { toast.error(result.error ?? 'Pedido não dispensado.'); return }
      setValue('')
      onDone()
    } catch { toast.error('Não foi possível dispensar o pedido.') }
    finally { setBusy(false) }
  }
  return (
    <form onSubmit={(event) => { event.preventDefault(); void save() }} className="bg-sunken rounded-[var(--radius-control)] p-2.5">
      <div className="mb-1.5 flex items-center gap-2"><label htmlFor={inputId} className="font-mono text-xs font-medium">{request.name}</label>
        <button type="button" onClick={() => void dismiss()} disabled={busy} aria-label={`Dispensar pedido ${request.name}`} className="text-muted hover:text-ink ml-auto shrink-0"><X className="h-3.5 w-3.5" /></button></div>
      {request.description && <p className="text-muted mb-2 text-xs">{request.description}</p>}
      <p id={`${inputId}-destination`} className="text-muted mb-2 break-all text-xs">{destination(request)}</p>
      {configured && <div className="flex items-center gap-1.5">
        <input id={inputId} name={request.name} type="password" value={value} disabled={busy} placeholder="Cole a chave" required maxLength={16384}
          aria-describedby={`${inputId}-destination`} onChange={(event) => setValue(event.target.value)} autoComplete="new-password" spellCheck={false}
          className="bg-surface min-w-0 flex-1 rounded px-2 py-1.5 font-mono text-xs outline-none" />
        <button type="submit" disabled={busy || !value.trim()} className="bg-accent text-accent-ink inline-flex shrink-0 items-center gap-1 rounded-[var(--radius-control)] px-2.5 py-1.5 text-xs font-medium disabled:opacity-50">
          {busy ? <Loader2 aria-label="Enviando" className="h-3.5 w-3.5 animate-spin" /> : `Salvar no ${request.target === 'supabase' ? 'Supabase' : 'Vercel'}`}
        </button>
      </div>}
    </form>
  )
}
