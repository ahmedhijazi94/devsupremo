'use client'

import { useEffect, useState } from 'react'
import { getProjectAutomation, saveProjectAutomation, type AutomationStatus } from '@/actions/automation'
import { capabilities, developmentCapabilities, type OperationCapability } from '@/lib/backend-operations/contract'
import { capabilityLabels, operationStateLabels } from '@/lib/backend-operations/presentation'
import { OperationApprovalsPanel } from './operation-approvals-panel'

export function BackendAutomation({ projectId }: { projectId: string }) {
  const [status, setStatus] = useState<AutomationStatus | null>(null)
  const [selected, setSelected] = useState<OperationCapability[]>([])
  const [enabled, setEnabled] = useState(false)
  const [maxRows, setMaxRows] = useState(25)
  const [hourly, setHourly] = useState(60)
  const [resources, setResources] = useState('')
  const [deviceIds, setDeviceIds] = useState<string[]>([])
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  async function refresh() {
    try {
    const result = await getProjectAutomation(projectId)
    setStatus(result)
    if (result.ok) {
      setSelected(result.policy?.capabilities ?? [])
      setEnabled(result.policy?.enabled ?? false)
      setMaxRows(result.policy?.maxRows ?? 25)
      setHourly(result.policy?.maxOperationsPerHour ?? 60)
      setResources(result.policy?.resources.join('\n') ?? '')
      setDeviceIds(result.policy?.deviceIds ?? [])
    }
    } catch { setMessage('A conexão foi interrompida. Tente atualizar novamente.'); setStatus({ ok: false, error: 'Não foi possível consultar a autorização.' }) }
  }
  useEffect(() => { let active = true; void getProjectAutomation(projectId).then(result => {
    if (!active) return
    setStatus(result)
    if (result.ok && result.policy) { setSelected(result.policy.capabilities); setEnabled(result.policy.enabled); setMaxRows(result.policy.maxRows); setHourly(result.policy.maxOperationsPerHour); setResources(result.policy.resources.join('\n')); setDeviceIds(result.policy.deviceIds) }
  }).catch(() => { if (active) setStatus({ ok: false, error: 'Não foi possível consultar a autorização.' }) }); return () => { active = false } }, [projectId])
  if (!status) return <p role="status">Carregando autorização e operações…</p>
  if (!status.ok) return <div><p role="alert">{status.error}</p><button onClick={() => void refresh()} className="mt-3 underline">Tentar novamente</button></div>
  const confirmed = status.environment === 'development' || status.environment === 'production'
  return <div className="space-y-6">
    <p className="text-sm">Ambiente: <strong>{status.environment === 'development' ? 'Desenvolvimento' : status.environment === 'production' ? 'Produção' : 'Ainda não confirmado'}</strong></p>
    <form className="space-y-4" onSubmit={async event => {
      event.preventDefault(); if (!confirmed) return; setBusy(true); setMessage('')
      try {
      const result = await saveProjectAutomation({ projectId, environment: status.environment, expectedRevision: status.policy?.revision ?? null,
        enabled, capabilities: selected, maxRows, maxOperationsPerHour: hourly, resources: resources.split('\n').map(value => value.trim()).filter(Boolean), deviceIds })
      setMessage(result.ok ? 'Autorização salva. O agente pode reutilizar estas permissões.' : result.error)
      if (result.ok) await refresh()
      } catch { setMessage('A conexão foi interrompida. Atualize para conferir se a autorização foi salva.') }
      finally { setBusy(false) }
    }}>
      <label className="flex items-center gap-2"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} disabled={!confirmed || busy} />Permitir automação neste ambiente</label>
      <p className="text-muted text-sm">Operações dentro destas permissões seguem sem nova pergunta. O motor continua verificando o dono, o ambiente, os limites e o resultado de cada ação.</p>
      {status.environment === 'development' && <div className="space-y-2">
        <button type="button" className="rounded-xl border px-3 py-2 text-sm" disabled={busy} onClick={() => { setSelected([...developmentCapabilities]); setEnabled(true); setResources('') }}>Selecionar perfil completo de desenvolvimento</button>
        <p className="text-muted text-sm">Autoriza todas as operações disponíveis em todos os recursos de desenvolvimento deste projeto. Mantém os computadores e limites escolhidos. Salve a autorização para aplicar.</p>
      </div>}
      <fieldset disabled={!confirmed || busy} className="grid gap-2 sm:grid-cols-2"><legend className="mb-2 font-medium">O que o agente pode fazer</legend>
        {capabilities.map(capability => <label key={capability} className="flex gap-2 text-sm"><input type="checkbox" checked={selected.includes(capability)} onChange={event => setSelected(current => event.target.checked ? [...current, capability] : current.filter(item => item !== capability))} />{capabilityLabels[capability]}</label>)}
      </fieldset>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm">Registros por operação<input aria-label="Registros por operação" type="number" min={1} max={1000} value={maxRows} onChange={event => setMaxRows(Number(event.target.value))} className="mt-1 block w-full rounded-lg border p-2" /></label>
        <label className="text-sm">Operações por hora<input aria-label="Operações por hora" type="number" min={1} max={1000} value={hourly} onChange={event => setHourly(Number(event.target.value))} className="mt-1 block w-full rounded-lg border p-2" /></label>
      </div>
      <label className="block text-sm">Recursos permitidos (um por linha; vazio permite os recursos deste projeto)<textarea value={resources} onChange={event => setResources(event.target.value)} className="mt-1 block w-full rounded-lg border p-2" rows={2} /></label>
      <fieldset disabled={!confirmed || busy} className="space-y-2"><legend className="text-sm font-medium">Computadores que podem executar</legend>
        <p className="text-muted text-xs">Sem seleção, permite todos os seus computadores autorizados. Seu acesso como dono no painel permanece disponível.</p>
        {(status.devices ?? []).map(device => <label key={device.id} className="flex gap-2 text-sm"><input type="checkbox" checked={deviceIds.includes(device.id)} onChange={event => setDeviceIds(current => event.target.checked ? [...current, device.id] : current.filter(id => id !== device.id))} />{device.label}</label>)}
      </fieldset>
      <button type="submit" disabled={busy || !confirmed} className="bg-accent text-accent-ink rounded-xl px-4 py-2 disabled:opacity-50">{busy ? 'Salvando…' : 'Salvar autorização'}</button>
      {message && <p role="status" className="text-sm">{message}</p>}
    </form>
    <OperationApprovalsPanel projectId={projectId} />
    <div className="border-t pt-4"><div className="flex justify-between"><h3 className="font-medium">Operações recentes</h3><button onClick={() => void refresh()} className="text-sm underline">Atualizar</button></div>
      {status.operations.length === 0 ? <p className="text-muted mt-3 text-sm">Nenhuma operação registrada neste canal.</p> : <ul className="mt-3 space-y-3">{status.operations.map(operation => <li key={operation.id} className="rounded-xl border p-3 text-sm">
        <p className="font-medium">{capabilityLabels[operation.capability]} · {operationStateLabels[operation.state]}</p><p>{operation.message}</p><p className="text-muted mt-1 break-all">{operation.id}</p>
      </li>)}</ul>}
    </div>
  </div>
}
