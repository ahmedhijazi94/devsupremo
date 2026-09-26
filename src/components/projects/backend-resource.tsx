'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { Loader2, RefreshCw } from 'lucide-react'
import { runProjectBackend } from '@/actions/project-backend'
import type {
  BackendInput,
  BackendResult,
} from '@/lib/project-backend/contract'

export type BackendSuccess = Extract<BackendResult, { ok: true }>
export const backendButton =
  'inline-flex items-center justify-center gap-2 rounded-lg bg-sunken px-3 py-2 text-xs font-medium hover:bg-line disabled:cursor-not-allowed disabled:opacity-40'
export const backendField =
  'border-line bg-surface w-full rounded-lg border px-3 py-2 text-sm'

export function BackendMetadata({ result }: { result: BackendSuccess }) {
  const environment = {
    development: 'Desenvolvimento',
    production: 'Produção',
    unknown: 'Ambiente não confirmado',
  }[result.environment]
  return (
    <p className="text-muted mt-4 text-xs break-words">
      {environment} · {result.projectRef} · Consultado em{' '}
      {new Date(result.observedAt).toLocaleString('pt-BR')}
    </p>
  )
}

export function BackendResource(props: {
  input: BackendInput
  label: string
  children: (result: BackendSuccess, refresh: () => void) => ReactNode
}) {
  return <ResourceRequest key={JSON.stringify(props.input)} {...props} />
}

function ResourceRequest({
  input,
  label,
  children,
}: {
  input: BackendInput
  label: string
  children: (result: BackendSuccess, refresh: () => void) => ReactNode
}) {
  const [result, setResult] = useState<BackendResult | null>(null)
  const [request] = useState(input)
  const [pending, setPending] = useState(true)
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    let active = true
    const load = async () => {
      setPending(true)
      try {
        const response = await runProjectBackend(request)
        if (active) setResult(response)
      } catch {
        if (active)
          setResult({
            ok: false,
            error: 'Não foi possível consultar o projeto. Tente novamente.',
          })
      } finally {
        if (active) setPending(false)
      }
    }
    void load()
    return () => {
      active = false
    }
  }, [nonce, request])
  const refresh = () => setNonce((value) => value + 1)
  return (
    <div aria-busy={pending}>
      <div className="mb-4 flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">{label}</h3>
        <button
          type="button"
          className={backendButton}
          onClick={refresh}
          disabled={pending}
          aria-label={`Atualizar ${label.toLowerCase()}`}
        >
          <RefreshCw aria-hidden="true" className="h-3.5 w-3.5" />
          Atualizar
        </button>
      </div>
      {pending ? (
        <p
          role="status"
          className="text-muted flex items-center gap-2 py-8 text-sm"
        >
          <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
          Carregando {label.toLowerCase()}…
        </p>
      ) : result?.ok ? (
        <>
          {result.data.message && (
            <p role="status" className="text-muted mb-4 text-sm">
              {result.data.message}
            </p>
          )}
          {children(result, refresh)}
          <BackendMetadata result={result} />
        </>
      ) : (
        <div
          role="alert"
          className="bg-down text-down-ink rounded-xl p-4 text-sm"
        >
          {result && !result.ok
            ? result.error
            : 'A consulta não retornou um resultado.'}
          <button
            type="button"
            onClick={refresh}
            className="ml-2 font-medium underline"
          >
            Tentar novamente
          </button>
        </div>
      )}
    </div>
  )
}
