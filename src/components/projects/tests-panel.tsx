'use client'

import { useEffect, useState } from 'react'
import {
  CheckCircle2,
  XCircle,
  Loader2,
  Clock,
  RefreshCw,
  Terminal,
} from 'lucide-react'
import {
  getProjectChecks,
  getCheckLog,
  type ProjectChecks,
} from '@/actions/checks'
import { cn } from '@/lib/utils'

/**
 * Os gates ao vivo, dentro do Supremo.
 *
 * Enquanto algo está rodando, a tela atualiza sozinha de poucos em poucos
 * segundos. Quando algo falha, dá para abrir o log com o contexto do erro
 * isolado — a linha que quebrou, não o dump inteiro.
 */
export function TestsPanel({ projectId }: { projectId: string }) {
  const [checks, setChecks] = useState<ProjectChecks | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [log, setLog] = useState<string | null>(null)
  const [loadingLog, setLoadingLog] = useState(false)
  // Muda para forçar um refetch manual (o botão de atualizar).
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout>

    async function tick() {
      const result = await getProjectChecks(projectId)
      if (!active) return
      if (result.error) {
        setError(result.error)
        return
      }
      setError(null)
      setChecks(result.data ?? null)
      // Enquanto houver check rodando, volta em 4s. Parado, para de consultar.
      if (result.data?.state === 'pending') {
        timer = setTimeout(tick, 4000)
      }
    }

    tick()
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [projectId, nonce])

  async function openLog(ref: string) {
    setLoadingLog(true)
    setLog(null)
    const result = await getCheckLog(projectId, ref)
    setLoadingLog(false)
    setLog(result.error ? `Erro: ${result.error}` : (result.log ?? ''))
  }

  if (error) {
    return (
      <div className="bg-surface flex h-full flex-col items-center justify-center gap-3 rounded-[var(--radius-inner)] p-8 text-center">
        <XCircle className="text-muted h-6 w-6" />
        <p className="text-sm font-medium">Não deu para ler os checks</p>
        <p className="text-muted max-w-sm text-sm">{error}</p>
      </div>
    )
  }

  if (!checks) {
    return (
      <div className="bg-surface flex h-full items-center justify-center rounded-[var(--radius-inner)]">
        <Loader2 className="text-muted h-6 w-6 animate-spin" />
      </div>
    )
  }

  return (
    <div className="bg-surface flex h-full min-h-0 flex-col overflow-hidden rounded-[var(--radius-inner)]">
      {/* Cabeçalho */}
      <div className="flex flex-wrap items-center gap-3 px-5 py-3">
        <StatePill state={checks.state} />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{checks.summary}</p>
          <p className="text-muted truncate text-xs">{checks.source}</p>
        </div>
        <button
          onClick={() => setNonce((n) => n + 1)}
          title="Atualizar"
          className="text-muted hover:bg-sunken hover:text-ink ml-auto rounded-[var(--radius-control)] p-2"
        >
          <RefreshCw className="h-4 w-4" />
        </button>
      </div>

      {/* Lista de gates */}
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">
        <ul className="space-y-2">
          {checks.checks.length === 0 ? (
            <li className="text-muted py-8 text-center text-sm">
              Nenhum check ainda — o CI pode não ter começado.
            </li>
          ) : (
            checks.checks.map((check) => (
              <li
                key={check.name}
                className="bg-sunken flex items-center gap-3 rounded-[var(--radius-control)] p-3"
              >
                <CheckIcon
                  status={check.status}
                  conclusion={check.conclusion}
                />
                <span className="flex-1 truncate text-sm font-medium">
                  {check.name}
                </span>
                {check.url && (
                  <a
                    href={check.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-muted hover:text-ink text-xs"
                  >
                    detalhes
                  </a>
                )}
              </li>
            ))
          )}
        </ul>

        {checks.state === 'failed' && (
          <button
            onClick={() => openLog(checks.ref)}
            disabled={loadingLog}
            className="bg-accent text-accent-ink mt-4 inline-flex items-center gap-2 rounded-[var(--radius-control)] px-3 py-1.5 text-sm font-medium disabled:opacity-50"
          >
            {loadingLog ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Terminal className="h-4 w-4" />
            )}
            Ver o que falhou
          </button>
        )}

        {log !== null && (
          <pre className="bg-ink text-surface mt-3 max-h-80 overflow-auto rounded-[var(--radius-control)] p-3 font-mono text-xs whitespace-pre-wrap">
            {log}
          </pre>
        )}
      </div>
    </div>
  )
}

function StatePill({ state }: { state: ProjectChecks['state'] }) {
  const map = {
    passed: { tone: 'bg-up text-up-ink', label: 'Tudo verde' },
    failed: { tone: 'bg-down text-down-ink', label: 'Falhou' },
    pending: { tone: 'bg-wait text-wait-ink', label: 'Rodando' },
  } as const
  const it = map[state]
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold',
        it.tone,
      )}
    >
      {state === 'pending' && <Loader2 className="h-3 w-3 animate-spin" />}
      {it.label}
    </span>
  )
}

function CheckIcon({
  status,
  conclusion,
}: {
  status: string
  conclusion: string | null
}) {
  if (status !== 'completed') {
    return status === 'in_progress' ? (
      <Loader2 className="text-wait-ink h-4 w-4 shrink-0 animate-spin" />
    ) : (
      <Clock className="text-muted h-4 w-4 shrink-0" />
    )
  }
  if (conclusion === 'success' || conclusion === 'skipped') {
    return <CheckCircle2 className="text-up-ink h-4 w-4 shrink-0" />
  }
  return <XCircle className="text-down-ink h-4 w-4 shrink-0" />
}
