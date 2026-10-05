'use client'
import { useState } from 'react'
import { getBackendUsage, saveBackendUsageLimits } from '@/actions/backend-observability'
import { usageMetricNames, type UsageLimit, type UsageReport } from '@/lib/backend-observability/contract'
import { BackendTable } from './backend-table'
import { backendButton, backendField } from './backend-resource'

export function BackendUsageHistory({ projectId, expectedRef, environment }: { projectId: string; expectedRef: string; environment: 'development' | 'production' }) {
  const [report, setReport] = useState<UsageReport | null>(null), [message, setMessage] = useState(''), [busy, setBusy] = useState(false)
  const [days, setDays] = useState(7), [metric, setMetric] = useState<UsageLimit['metric']>('Tamanho do banco'), [maximum, setMaximum] = useState('')
  const scope = { projectId, expectedRef, environment }
  async function load() {
    setBusy(true); setMessage('')
    try { const result = await getBackendUsage({ ...scope, days }); if (result.ok) setReport(result.report); else setMessage(result.error) }
    catch { setMessage('Não foi possível confirmar o histórico. Atualize para tentar novamente.') }
    finally { setBusy(false) }
  }
  async function save(limits: UsageLimit[]) {
    setBusy(true); setMessage('')
    try { const result = await saveBackendUsageLimits({ ...scope, limits }); if (!result.ok) setMessage(result.error); else await load() }
    catch { setMessage('Não foi possível confirmar os limites. Atualize antes de salvar novamente.') }
    finally { setBusy(false) }
  }
  return <section className="mt-6 space-y-4 border-t pt-5" aria-label="Histórico e alertas de uso">
    <h3 className="text-sm font-semibold">Histórico e alertas</h3>
    <p className="text-muted text-xs">Registre uma amostra ao consultar. Não há coleta contínua nem notificações fora deste painel.</p>
    <div className="flex flex-wrap items-end gap-3"><label className="text-sm">Histórico<select className={backendField} value={days} onChange={event => setDays(Number(event.target.value))}><option value={1}>24 horas</option><option value={7}>7 dias</option><option value={30}>30 dias</option></select></label>
      <button type="button" className={backendButton} disabled={busy} onClick={() => void load()}>{busy ? 'Consultando…' : 'Registrar amostra e abrir histórico'}</button></div>
    {message && <p role="alert" className="text-sm">{message}</p>}
    {report && <>
      <p className="text-muted text-xs">{report.historyMessage}</p>
      <p className="text-sm">Cota do motor: {report.engineQuota.maximum === null ? 'não configurada' : `${report.engineQuota.maximum} operações por hora`}{report.engineQuota.enabled === false ? ' · automação desativada' : ''}. Cotas e faturamento do fornecedor: indisponíveis neste relatório.</p>
      <p className="text-muted text-xs">{report.engineQuota.note}</p>
      {report.alerts.map(alert => <div key={alert.metric} className="rounded-lg border p-3 text-sm" role={alert.state === 'limit_reached' ? 'alert' : 'status'}>
        {alert.metric}: {alert.state === 'unavailable' ? 'leitura indisponível; limite não avaliado' : `${alert.value?.toLocaleString('pt-BR')} de ${alert.maximum.toLocaleString('pt-BR')}${alert.state === 'limit_reached' ? ' · limite atingido' : ' · abaixo do limite'}`}
        <button type="button" disabled={busy || !report.historyAvailable} className={`${backendButton} ml-3`} onClick={() => void save(report.limits.filter(limit => limit.metric !== alert.metric))}>Remover alerta de {alert.metric}</button>
      </div>)}
      <form className="space-y-3" onSubmit={event => { event.preventDefault(); void save([...report.limits.filter(limit => limit.metric !== metric), { metric, maximum: Number(maximum) }]) }}>
        <label className="block text-sm">Indicador para alerta<select className={backendField} value={metric} onChange={event => setMetric(event.target.value as UsageLimit['metric'])}>{usageMetricNames.map(name => <option key={name}>{name}</option>)}</select></label>
        <label className="block text-sm">Avisar ao atingir (bytes nos indicadores de tamanho)<input className={backendField} type="number" min={1} required value={maximum} onChange={event => setMaximum(event.target.value)} /></label>
        <p className="text-muted text-xs">Este limite apenas mostra um alerta; não altera a cota de automação nem bloqueia o provedor.</p>
        <button className={backendButton} disabled={busy || !report.historyAvailable} type="submit">Salvar limite de alerta</button>
      </form>
      <label className="block text-sm">Indicador do histórico<select className={backendField} value={metric} onChange={event => setMetric(event.target.value as UsageLimit['metric'])}>{usageMetricNames.map(name => <option key={name}>{name}</option>)}</select></label>
      <BackendTable caption={`Amostras de ${metric}`} rows={report.history.map(sample => {
        const value = sample.metrics.find(item => item.name === metric)
        return { Coleta: sample.observedAt, Valor: value?.available ? value.value : 'Indisponível', Unidade: value?.unit ?? 'quantidade' }
      })} empty="Nenhuma amostra registrada neste período e ambiente." />
    </>}
  </section>
}
