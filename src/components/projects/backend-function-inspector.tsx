'use client'
import { useState } from 'react'
import { administerProjectBackend } from '@/actions/backend-administration'
import type { FunctionResponse } from '@/lib/edge-functions/contract'
import { BackendResource, backendButton } from './backend-resource'
import { BackendTable } from './backend-table'
import { browserOperation } from '@/lib/project-backend/browser-operation'

export function BackendFunctionInspector({ projectId, expectedRef, environment, slug, currentVersion }: { projectId: string; expectedRef: string; environment: 'development' | 'production'; slug: string; currentVersion?: number }) {
  const [history, setHistory] = useState<Extract<FunctionResponse, { operation: 'functions-history' }>['data'] | null>(null)
  const [code, setCode] = useState<Extract<FunctionResponse, { operation: 'functions-code' }>['data'] | null>(null)
  const [message, setMessage] = useState(''), [busy, setBusy] = useState(false), [logs, setLogs] = useState(false)
  async function read(operation: 'functions-history' | 'functions-code' | 'functions-test', version?: number) {
    setBusy(true); setMessage('')
    let operationId = ''
    try {
      const options = { operation, environment, slug, ...(operation === 'functions-code' ? { version } : {}), ...(operation === 'functions-test' ? { expectedVersion: currentVersion } : {}) }
      const attempt = operation === 'functions-test' ? await browserOperation(projectId, { expectedRef, options }) : null
      operationId = attempt?.id ?? crypto.randomUUID()
      const result = await administerProjectBackend({ projectId, expectedRef, operationId, kind: 'function', options })
      if (!result.ok) { setMessage(result.error); return }
      attempt?.confirmed()
      const response = result.data as FunctionResponse
      if (response.operation === 'functions-history') setHistory(response.data)
      else if (response.operation === 'functions-code') setCode(response.data)
      else if (response.operation === 'functions-test') setMessage(`Assinatura confirmada na versão ${response.data.function.version}: quatro pedidos vazios. Envio e entrega de email não foram testados. Operação ${operationId}.`)
    } catch { setMessage(`Resposta não confirmada. Consulte a operação ${operationId} antes de repetir um ensaio.`) }
    finally { setBusy(false) }
  }
  return <section className="mt-4 space-y-3" aria-label={`Código e teste de ${slug}`}>
    <div className="flex flex-wrap gap-2"><button className={backendButton} type="button" disabled={busy} onClick={() => void read('functions-history')}>Ver versões guardadas</button>
      <button className={backendButton} type="button" disabled={busy || !currentVersion} onClick={() => void read('functions-test')}>Testar assinatura do envio de autenticação</button>
      <button className={backendButton} type="button" onClick={() => setLogs(value => !value)}>Buscar {slug} nos logs</button></div>
    <p className="text-muted text-xs">O ensaio está disponível para o hook de email instalado: verifica a rejeição de assinaturas inválidas e de um pedido vazio válido. Não executa entradas arbitrárias nem comprova entrega.</p>
    {message && <p role="status" className="text-sm">{message}</p>}
    {history && <div className="space-y-2"><p className="text-muted text-xs">Até 100 versões publicadas por este motor no banco e ambiente atuais. Versões externas podem não ter código disponível.{!history.complete && ' Existem versões anteriores fora desta página.'}</p>
      {history.versions.length ? history.versions.map(version => <div key={version.version} className="flex items-center justify-between gap-3 rounded-lg border p-3 text-sm"><span>Versão {version.version} · {version.createdAt}</span><button type="button" disabled={busy} className={backendButton} onClick={() => void read('functions-code', version.version)}>Ver código da versão {version.version}</button></div>) : <p className="text-sm">Nenhum artefato guardado para esta função.</p>}
    </div>}
    {code && <div><h4 className="text-sm font-semibold">Prévia estrutural · versão {code.version}</h4><p className="text-muted text-xs">Linhas com valores literais ou comentários ficam ocultas para proteger credenciais. Esta prévia não é o código completo para republicação.</p>{code.files.map(file => <details className="mt-3 rounded-lg border p-3" key={file.path}><summary className="cursor-pointer text-xs">{file.path}{file.truncated ? ' · prévia limitada' : ''}</summary><pre className="mt-3 overflow-auto whitespace-pre-wrap text-xs">{file.content}</pre></details>)}</div>}
    {logs && <><p className="text-muted text-xs">Busca pelo nome no texto, nos últimos 60 minutos; só encontra eventos que mencionam a função. Retenção e disponibilidade dependem do provedor.</p><BackendResource input={{ projectId, operation: 'logs', source: 'functions', search: slug, minutes: 60, limit: 50, offset: 0 }} label={`Logs que mencionam ${slug}`}>{({ data }) => <BackendTable rows={data.items} columns={data.columns} caption={`Logs que mencionam ${slug}`} />}</BackendResource></>}
  </section>
}
