'use client'

import { useEffect, useState } from 'react'
import { KeyRound, Check, Loader2, X } from 'lucide-react'
import {
  getSecretRequests,
  saveSecret,
  dismissSecretRequest,
  type SecretRequestView,
} from '@/actions/secrets'
import { toast } from 'sonner'

/**
 * Onde o dono preenche os secrets que o agente pediu. O agente registra o
 * PEDIDO (nome + para que serve); aqui o dono digita o valor, que vai direto
 * para a env var na Vercel. O valor nunca passa pelo banco do Supremo nem pelo
 * agente — é o jeito certo de credencial: quem digita o segredo é o dono.
 */
export function SecretsCard({ projectId }: { projectId: string }) {
  const [requests, setRequests] = useState<SecretRequestView[] | null>(null)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    let active = true
    getSecretRequests(projectId).then((res) => {
      if (!active) return
      setRequests(res.requests ?? [])
    })
    return () => {
      active = false
    }
  }, [projectId, nonce])

  // Sem pedidos: nada na tela.
  if (!requests || requests.length === 0) return null

  return (
    <section className="bg-surface rounded-[var(--radius-inner)] p-4">
      <div className="mb-1 flex items-center gap-2">
        <KeyRound className="text-accent h-4 w-4 shrink-0" />
        <h2 className="text-sm font-semibold">Secrets pedidos pelo agente</h2>
      </div>
      <p className="text-muted mb-3 text-xs">
        Você digita, o valor vai direto pra Vercel. O agente nunca vê.
      </p>

      <ul className="space-y-3">
        {requests.map((req) => (
          <li key={req.name}>
            {req.status === 'fulfilled' ? (
              <div className="text-muted flex items-center gap-2 text-xs">
                <Check className="text-up-ink h-3.5 w-3.5 shrink-0" />
                <span className="font-mono">{req.name}</span>
                <span>configurado</span>
              </div>
            ) : (
              <SecretForm
                projectId={projectId}
                request={req}
                onDone={() => setNonce((n) => n + 1)}
              />
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}

function SecretForm({
  projectId,
  request,
  onDone,
}: {
  projectId: string
  request: SecretRequestView
  onDone: () => void
}) {
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)

  async function save() {
    if (!value.trim()) return
    setBusy(true)
    const res = await saveSecret({ projectId, name: request.name, value })
    setBusy(false)
    if (res.error) {
      toast.error(res.error)
      return
    }
    toast.success(`${request.name} configurado. Vale no próximo deploy.`)
    onDone()
  }

  async function dismiss() {
    setBusy(true)
    const res = await dismissSecretRequest({ projectId, name: request.name })
    setBusy(false)
    if (res.error) {
      toast.error(res.error)
      return
    }
    onDone()
  }

  return (
    <div className="bg-sunken rounded-[var(--radius-control)] p-2.5">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="font-mono text-xs font-medium">{request.name}</span>
        <button
          onClick={dismiss}
          disabled={busy}
          title="Dispensar este pedido"
          className="text-muted hover:text-ink ml-auto shrink-0"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      {request.description && (
        <p className="text-muted mb-2 text-xs">{request.description}</p>
      )}
      <div className="flex items-center gap-1.5">
        <input
          type={request.isSecret ? 'password' : 'text'}
          value={value}
          disabled={busy}
          placeholder={request.isSecret ? 'Cole a chave' : 'Valor'}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save()
          }}
          autoComplete="off"
          className="bg-surface min-w-0 flex-1 rounded px-2 py-1.5 font-mono text-xs outline-none"
        />
        <button
          onClick={save}
          disabled={busy || !value.trim()}
          className="bg-accent text-accent-ink inline-flex shrink-0 items-center gap-1 rounded-[var(--radius-control)] px-2.5 py-1.5 text-xs font-medium disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Salvar'}
        </button>
      </div>
    </div>
  )
}
