'use client'
import { useEffect, useState } from 'react'
import { getProjectAutomation } from '@/actions/automation'
import { manageProjectStorage } from '@/actions/project-storage'
import type { StorageOptions } from '@/lib/project-storage/contract'
import { backendButton, backendField } from './backend-resource'
import { BackendTable } from './backend-table'
import { browserOperation } from '@/lib/project-backend/browser-operation'

export function BackendStorageManager({ projectId }: { projectId: string }) {
  const [target, setTarget] = useState<{ expectedRef: string; environment: 'development' | 'production' } | null>(null)
  const [bucket, setBucket] = useState('')
  const [prefix, setPrefix] = useState('')
  const [path, setPath] = useState('')
  const [items, setItems] = useState<Record<string, unknown>[]>([])
  const [message, setMessage] = useState('')
  const [download, setDownload] = useState('')
  const [busy, setBusy] = useState(false)
  const [file, setFile] = useState<File | null>(null)
  useEffect(() => { let current = true; void getProjectAutomation(projectId).then(result => {
    if (!current) return
    if (result.ok && result.projectRef && result.environment !== 'unknown') setTarget({ expectedRef: result.projectRef, environment: result.environment })
    else setMessage(result.ok ? 'Confirme o ambiente conectado para administrar arquivos.' : result.error)
  }).catch(() => { if (current) setMessage('Não foi possível consultar o ambiente. Atualize para tentar novamente.') }); return () => { current = false } }, [projectId])
  async function run(options: StorageOptions) {
    setBusy(true); setMessage(''); setDownload('')
    try {
      const { operationId: _operationId, ...payload } = options as StorageOptions & { operationId?: string }
      const attempt = _operationId ? await browserOperation(projectId, payload) : null
      const result = await manageProjectStorage({ projectId, options: attempt ? { ...options, operationId: attempt.id } : options })
      if (!result.ok) setMessage(result.error)
      else {
        if (Array.isArray(result.data.items)) setItems(result.data.items as Record<string, unknown>[])
        if (typeof result.data.url === 'string') setDownload(result.data.url)
        const receipt = result.data.receipt as { message?: string; state?: string } | undefined
        if (receipt?.state === 'succeeded') attempt?.confirmed()
        setMessage(receipt?.message ?? (options.operation === 'storage-buckets' && Array.isArray(result.data.items) && result.data.items.length === 0 ? 'Nenhum espaço de arquivos criado neste projeto.' : 'Consulta concluída.'))
      }
    } catch { setMessage('A conexão foi interrompida. Confira a operação em Automação antes de repetir.') }
    finally { setBusy(false) }
  }
  return <div className="space-y-4">
    <div className="flex flex-wrap gap-2"><button className={backendButton} disabled={busy || !target} onClick={() => target && void run({ ...target, operation: 'storage-buckets' })}>Listar espaços</button></div>
    <label className="block text-sm">Espaço de arquivos<input className={backendField} value={bucket} onChange={event => setBucket(event.target.value)} placeholder="arquivos" /></label>
    <label className="block text-sm">Pasta<input className={backendField} value={prefix} onChange={event => setPrefix(event.target.value)} placeholder="Deixe vazio para abrir a raiz" /></label>
    <button className={backendButton} disabled={busy || !target || !bucket} onClick={() => target && void run({ ...target, operation: 'storage-list', bucket, prefix, offset: 0 })}>Abrir arquivos</button>
    <BackendTable rows={items} caption="Armazenamento do projeto" empty="Escolha um espaço para consultar arquivos." />
    <details className="rounded-xl border p-4"><summary className="cursor-pointer text-sm font-medium">Enviar, baixar ou excluir um arquivo</summary>
      <div className="mt-3 space-y-3">
        <label className="block text-sm">Caminho completo no espaço<input className={backendField} value={path} onChange={event => setPath(event.target.value)} placeholder="pasta/arquivo.pdf" /></label>
        <label className="block text-sm">Arquivo para enviar (até 512 KB)<input type="file" className={backendField} onChange={event => setFile(event.target.files?.[0] ?? null)} /></label>
        <div className="flex flex-wrap gap-2">
          <button className={backendButton} disabled={busy || !target || !bucket || !path || !file} onClick={async () => {
            if (!target || !file) return
            if (file.size > 512_000) { setMessage('Selecione um arquivo de até 512 KB.'); return }
            const bytes = new Uint8Array(await file.arrayBuffer()); let value = ''; for (const byte of bytes) value += String.fromCharCode(byte)
            await run({ ...target, operation: 'storage-upload', operationId: crypto.randomUUID(), bucket, path, content: btoa(value), contentType: file.type || 'application/octet-stream' })
          }}>Enviar arquivo novo</button>
          <button className={backendButton} disabled={busy || !target || !bucket || !path} onClick={() => target && void run({ ...target, operation: 'storage-download', bucket, path })}>Preparar download</button>
          <button className={backendButton} disabled={busy || !target || !bucket || !path} onClick={() => target && void run({ ...target, operation: 'storage-remove', operationId: crypto.randomUUID(), bucket, paths: [path] })}>Excluir este arquivo</button>
        </div>
        {download && <a className="text-sm underline" href={download} target="_blank" rel="noopener noreferrer">Baixar arquivo · link válido por 1 minuto</a>}
      </div>
    </details>
    <StorageBucketSettings disabled={busy || !target} bucket={bucket} onSubmit={settings => target ? run({ ...target, bucket, operationId: crypto.randomUUID(), ...settings }) : Promise.resolve()} />
    {message && <p role="status" className="text-sm">{message}</p>}
  </div>
}
function StorageBucketSettings({ disabled, bucket, onSubmit }: { disabled: boolean; bucket: string; onSubmit(options: { operation: 'storage-create-bucket' | 'storage-update-bucket'; public: boolean; maxBytes: number; mimeTypes: string[] } | { operation: 'storage-delete-bucket' }): Promise<void> }) {
  const [isPublic, setPublic] = useState(false), [maxBytes, setMaxBytes] = useState(5_000_000), [mime, setMime] = useState('image/png,image/jpeg,application/pdf')
  return <details className="rounded-xl border p-4"><summary className="cursor-pointer text-sm font-medium">Configurar espaço</summary><div className="mt-3 space-y-3">
    <label className="flex gap-2 text-sm"><input type="checkbox" checked={isPublic} onChange={event => setPublic(event.target.checked)} />Permitir leitura pública dos arquivos</label>
    <label className="block text-sm">Tamanho máximo de cada arquivo em bytes<input type="number" min={1} max={50000000} className={backendField} value={maxBytes} onChange={event => setMaxBytes(Number(event.target.value))} /></label>
    <label className="block text-sm">Tipos permitidos, separados por vírgula<input className={backendField} value={mime} onChange={event => setMime(event.target.value)} /></label>
    <div className="flex flex-wrap gap-2">{(['storage-create-bucket', 'storage-update-bucket'] as const).map((operation, index) => <button key={operation} className={backendButton} disabled={disabled || !bucket} onClick={() => void onSubmit({ operation, public: isPublic, maxBytes, mimeTypes: mime.split(',').map(value => value.trim()) })}>{index === 0 ? 'Criar espaço' : 'Salvar configuração'}</button>)}<button className={backendButton} disabled={disabled || !bucket} onClick={() => void onSubmit({ operation: 'storage-delete-bucket' })}>Remover espaço vazio</button></div>
  </div></details>
}
