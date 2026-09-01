'use client'

import { useState, useTransition } from 'react'
import { Loader2, CheckCircle2, ShieldCheck } from 'lucide-react'
import {
  approveBootstrapDevice,
  getBootstrapGrantInfo,
} from '@/actions/bootstrap'

type Info = { projectName: string; status: string; expired: boolean }

export function BootstrapAuthorize({ initialCode }: { initialCode: string }) {
  const [code, setCode] = useState(initialCode)
  const [info, setInfo] = useState<Info | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [approved, setApproved] = useState(false)
  const [pending, startTransition] = useTransition()

  function check() {
    setError(null)
    setInfo(null)
    startTransition(async () => {
      const res = await getBootstrapGrantInfo(code)
      if ('error' in res) setError(res.error)
      else setInfo(res)
    })
  }

  function approve() {
    setError(null)
    startTransition(async () => {
      const res = await approveBootstrapDevice(code)
      if (res.error) setError(res.error)
      else setApproved(true)
    })
  }

  if (approved) {
    return (
      <div className="bg-surface flex flex-col items-center gap-3 rounded-[var(--radius-inner)] p-8 text-center">
        <CheckCircle2 className="text-up-ink h-10 w-10" />
        <p className="text-ink font-medium">Máquina autorizada 🎉</p>
        <p className="text-muted text-sm">
          Volte ao terminal — o bootstrap vai continuar sozinho.
        </p>
      </div>
    )
  }

  return (
    <div className="bg-surface flex flex-col gap-4 rounded-[var(--radius-inner)] p-6">
      <label className="text-muted text-xs font-medium">
        Código do terminal
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="XXXX-XXXX"
          className="bg-sunken text-ink mt-1 w-full rounded-[var(--radius-control)] px-3 py-2 font-mono text-sm tracking-widest uppercase"
        />
      </label>

      {error && <p className="text-down-ink text-sm">{error}</p>}

      {info && !info.expired && (
        <div className="text-ink flex items-center gap-2 text-sm">
          <ShieldCheck className="text-accent h-4 w-4" />
          Autorizar bootstrap de <strong>{info.projectName}</strong> nesta máquina?
        </div>
      )}
      {info?.expired && (
        <p className="text-down-ink text-sm">
          Código expirado — rode o comando de novo no terminal.
        </p>
      )}

      {info && !info.expired ? (
        <button
          onClick={approve}
          disabled={pending}
          className="bg-accent text-accent-ink inline-flex items-center justify-center gap-2 rounded-[var(--radius-control)] px-4 py-2 text-sm font-medium disabled:opacity-50"
        >
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          Autorizar
        </button>
      ) : (
        <button
          onClick={check}
          disabled={pending || code.trim().length < 4}
          className="bg-accent text-accent-ink inline-flex items-center justify-center gap-2 rounded-[var(--radius-control)] px-4 py-2 text-sm font-medium disabled:opacity-40"
        >
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          Verificar código
        </button>
      )}
    </div>
  )
}
