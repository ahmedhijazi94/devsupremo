'use client'

import { useEffect, useState, useTransition } from 'react'
import { getProjectAutomation } from '@/actions/automation'
import { requestAuthProvider } from '@/actions/auth-provider-request'
import { backendButton, backendField } from './backend-resource'

export function BackendAuthProvider({ projectId }: { projectId: string }) {
  return <AuthProviderForm key={projectId} projectId={projectId} />
}

function AuthProviderForm({ projectId }: { projectId: string }) {
  const [target, setTarget] = useState<{ expectedRef: string; environment: 'development' | 'production' } | null>(null)
  const [provider, setProvider] = useState<'google' | 'github'>('google')
  const [clientId, setClientId] = useState('')
  const [message, setMessage] = useState('')
  const [prepared, setPrepared] = useState(false)
  const [busy, startTransition] = useTransition()
  useEffect(() => {
    let active = true
    void getProjectAutomation(projectId).then(result => {
      if (!active) return
      if (result.ok && result.environment !== 'unknown' && result.projectRef)
        setTarget({ environment: result.environment, expectedRef: result.projectRef })
      else setMessage(result.ok ? 'O ambiente ainda não foi confirmado.' : result.error)
    }).catch(() => { if (active) setMessage('Não foi possível consultar o ambiente. Atualize para tentar novamente.') })
    return () => { active = false }
  }, [projectId])
  return <details className="mt-5 rounded-xl border p-4">
    <summary className="cursor-pointer text-sm font-medium">Login com Google ou GitHub</summary>
    <form className="mt-4 space-y-3" onSubmit={event => {
      event.preventDefault()
      if (!target || busy) return
      setPrepared(false)
      startTransition(async () => {
        try {
          const result = await requestAuthProvider({ projectId, ...target, provider, clientId })
          if (!result.ok) { setMessage(result.error ?? 'Não foi possível preparar o campo seguro.'); return }
          setPrepared(true)
          setMessage(result.status === 'fulfilled'
            ? 'Esta configuração já foi salva. Para trocar o segredo, dispense o pedido anterior em Configuração segura e prepare um novo campo.'
            : 'Campo seguro preparado. Preencha o client secret em Configuração segura para aplicar ao Supabase.')
          window.dispatchEvent(new Event('supremo:secret-requests-changed'))
        } catch { setMessage('Não foi possível confirmar o pedido. Consulte Configuração segura antes de tentar novamente.') }
      })
    }}>
      <p className="text-muted text-sm">Informe o Client ID público do app OAuth. O client secret será preenchido no formulário seguro e poderá ficar no cofre deste projeto.</p>
      {target && <p className="break-words text-sm">{target.environment === 'production' ? 'Produção' : 'Desenvolvimento'} · {target.expectedRef}</p>}
      <label className="block text-sm">Provedor de login<select className={backendField} disabled={busy} value={provider} onChange={event => setProvider(event.target.value as 'google' | 'github')}>
        <option value="google">Google</option><option value="github">GitHub</option>
      </select></label>
      <label className="block text-sm">Client ID público<input className={backendField} value={clientId} onChange={event => setClientId(event.target.value)} required maxLength={512} disabled={busy} autoComplete="off" spellCheck={false} /></label>
      <p className="text-muted text-xs">O app OAuth e o callback precisam estar configurados no provedor. Salvar a configuração não confirma que um login foi realizado.</p>
      <button type="submit" className={backendButton} disabled={!target || busy}>{busy ? 'Preparando…' : 'Preparar campo seguro'}</button>
      {message && <p role="status" className="text-sm">{message}</p>}
      {prepared && <a className="block text-sm underline" href="#secrets">Ir para Configuração segura</a>}
    </form>
  </details>
}
