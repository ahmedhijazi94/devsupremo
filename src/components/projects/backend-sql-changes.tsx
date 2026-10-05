'use client'
import { useState } from 'react'
import { prepareProjectSql, projectSqlArtifacts, type SqlArtifactActionResult } from '@/actions/sql-artifacts'
import { backendButton, backendField } from './backend-resource'

export function BackendSqlChanges({ projectId, expectedRef }: { projectId: string; expectedRef: string }) {
  const [content, setContent] = useState(''), [busy, setBusy] = useState(false), [result, setResult] = useState<SqlArtifactActionResult | null>(null)
  return <details className="mt-5 rounded-xl border p-4"><summary className="cursor-pointer text-sm font-medium">Alterar estrutura com histórico</summary>
    <p className="mt-3 text-sm text-muted-foreground">A alteração será gravada no projeto antes de chegar ao banco de desenvolvimento. Regras de acesso e verificações de segurança continuam obrigatórias.</p>
    <form className="mt-4 space-y-3" onSubmit={async event => { event.preventDefault(); setBusy(true); try { setResult(await prepareProjectSql({ projectId, expectedRef, content })) } finally { setBusy(false) } }}>
      <label className="block text-sm">Alteração SQL<textarea className={`${backendField} min-h-36 font-mono`} value={content} onChange={event => setContent(event.target.value)} required /></label>
      <button className={backendButton} disabled={busy} type="submit">{busy ? 'Conferindo…' : 'Preparar alteração'}</button>
      <button className={`${backendButton} ml-2`} disabled={busy} type="button" onClick={async () => { setBusy(true); try { setResult(await projectSqlArtifacts({ projectId, expectedRef })) } finally { setBusy(false) } }}>Atualizar andamento</button>
    </form>
    {result && !result.ok && <p role="alert" className="mt-3 text-sm">{result.error}</p>}
    {result?.ok && <div className="mt-3 space-y-3 text-sm"><p role="status">{result.executorAvailable ? 'Executor disponível. Alterações preparadas serão conferidas no projeto.' : 'Executor indisponível. Alterações permanecem preparadas; abra o projeto no computador autorizado para continuar.'}</p>
      {result.artifacts.map(artifact => <div key={artifact.id} className="rounded-lg border p-3"><p>{artifact.message}</p><p className="mt-1 break-all text-xs text-muted-foreground">{artifact.path}</p><p className="mt-1 text-xs">Acompanhamento: {artifact.id}</p></div>)}
    </div>}
  </details>
}
