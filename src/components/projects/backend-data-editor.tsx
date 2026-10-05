'use client'
import { useState } from 'react'
import { administerProjectBackend, prepareDataEdit, prepareDataImport } from '@/actions/backend-administration'
import type { AdministrationResult } from '@/lib/project-backend/administration'
import { backendButton, backendField } from './backend-resource'

export function BackendDataEditor({ projectId, expectedRef, table }: { projectId: string; expectedRef: string; table: string }) {
  const [type, setType] = useState('update')
  const [batch, setBatch] = useState(false)
  const [keyText, setKeyText] = useState('{"id":""}')
  const [valuesText, setValuesText] = useState('{}')
  const [rowsText, setRowsText] = useState('[{"key":{"id":""},"values":{}}]')
  const [plan, setPlan] = useState<{ token: string; count: number; expiresAt: string } | null>(null)
  const [result, setResult] = useState<AdministrationResult | null>(null)
  const [busy, setBusy] = useState(false)
  async function prepare() {
    setBusy(true); setResult(null); setPlan(null)
    try {
      const response = batch
        ? await prepareDataImport({ projectId, expectedRef, table, type, rowsText })
        : await prepareDataEdit({ projectId, expectedRef, table, type, keyText, valuesText })
      setResult(response)
      if (response.ok && response.data && typeof response.data === 'object' && 'data' in response.data) {
        const data = response.data.data as { planToken?: string; impactCount?: number; expiresAt?: string }
        if (data.planToken && data.impactCount !== undefined && data.expiresAt) setPlan({ token: data.planToken, count: data.impactCount, expiresAt: data.expiresAt })
      }
    } catch { setResult({ ok: false, error: 'Não foi possível conferir a alteração. Seus campos foram preservados.' }) }
    finally { setBusy(false) }
  }
  async function apply() {
    if (!plan) return
    setBusy(true)
    try { setResult(await administerProjectBackend({ projectId, expectedRef, operationId: crypto.randomUUID(), kind: 'data', options: { operation: 'data-apply', environment: 'development', planToken: plan.token } })) }
    catch { setResult({ ok: false, error: 'A confirmação não chegou. Confira o recibo em Automação antes de preparar outra alteração.' }) }
    finally { setPlan(null); setBusy(false) }
  }
  return <details className="mt-5 rounded-xl border p-4"><summary className="cursor-pointer break-words text-sm font-medium">Editar ou importar registros de {table}</summary>
    <form className="mt-4 space-y-3" onSubmit={event => { event.preventDefault(); void prepare() }}>
      <label className="block text-sm">Operação<select value={type} onChange={event => { setType(event.target.value); setPlan(null); if (event.target.value === 'delete') setBatch(false) }} className={backendField}><option value="update">Editar</option><option value="insert">Criar</option><option value="upsert">Criar ou editar</option><option value="delete">Excluir</option></select></label>
      {type !== 'delete' && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={batch} onChange={event => { setBatch(event.target.checked); setPlan(null) }} />Importar até 25 registros</label>}
      {batch ? <><p className="text-xs text-muted">Cada item precisa de “key” com a chave do registro e “values” com os campos desejados. O impacto será conferido antes da aplicação.</p>
        <label className="block text-sm">Arquivo JSON<input type="file" accept="application/json,.json" className={backendField} onChange={async event => {
          setPlan(null); setResult(null)
          const file = event.target.files?.[0]
          if (!file) return
          if (file.size > 100_000) { setResult({ ok: false, error: 'O arquivo precisa ter até 100 KB.' }); return }
          try { setRowsText(await file.text()) } catch { setResult({ ok: false, error: 'Não foi possível ler o arquivo.' }) }
        }} /></label>
        <label className="block text-sm">Registros (JSON)<textarea className={backendField} value={rowsText} onChange={event => { setRowsText(event.target.value); setPlan(null) }} /></label></>
        : <><label className="block text-sm">Chave do registro (JSON)<textarea className={backendField} value={keyText} onChange={event => { setKeyText(event.target.value); setPlan(null) }} /></label>
          {type !== 'delete' && <label className="block text-sm">Campos que deseja alterar (JSON)<textarea className={backendField} value={valuesText} onChange={event => { setValuesText(event.target.value); setPlan(null) }} /></label>}</>}
      <button disabled={busy} className={backendButton} type="submit">{busy ? 'Conferindo…' : 'Conferir alteração'}</button>
    </form>
    {plan && <div className="mt-4 space-y-2 text-sm"><p>Impacto confirmado: {plan.count} registro(s). Plano válido até {new Date(plan.expiresAt).toLocaleTimeString('pt-BR')}.</p>
      <button className={backendButton} disabled={busy} onClick={() => void apply()}>Aplicar alteração</button>
    </div>}
    {result && !result.ok && <p role="alert" className="mt-3 text-sm">{result.error}</p>}
    {result?.ok && !plan && <p role="status" className="mt-3 text-sm">Pedido registrado. Confira o resultado em Automação e atualize os registros.</p>}
  </details>
}
