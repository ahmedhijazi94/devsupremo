'use client'

import { useEffect, useState, useTransition } from 'react'
import {
  Table2,
  ShieldCheck,
  ShieldOff,
  KeyRound,
  FunctionSquare,
  Loader2,
  RefreshCw,
} from 'lucide-react'
import {
  getDatabaseOverview,
  getTableDetail,
  type DatabaseOverview,
  type TableDetail,
} from '@/actions/database'
import { cn } from '@/lib/utils'

/**
 * A aba do banco: tabelas, colunas, policies de RLS e Edge Functions, tudo
 * read-only, direto no Supremo. É a prova visível do que o agente construiu —
 * e do isolamento (as policies aparecem por tabela).
 */
export function DatabasePanel({ projectId }: { projectId: string }) {
  const [overview, setOverview] = useState<DatabaseOverview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [loading, startLoading] = useTransition()

  function load() {
    startLoading(async () => {
      const result = await getDatabaseOverview(projectId)
      if (result.error) {
        setError(result.error)
        return
      }
      setError(null)
      setOverview(result.data ?? null)
      if (!selected && result.data?.tables[0]) {
        setSelected(result.data.tables[0].name)
      }
    })
  }

  useEffect(load, [projectId]) // eslint-disable-line react-hooks/exhaustive-deps

  if (error) {
    return (
      <div className="bg-surface flex h-full flex-col items-center justify-center gap-3 rounded-[var(--radius-inner)] p-8 text-center">
        <ShieldOff className="text-muted h-6 w-6" />
        <p className="text-sm font-medium">Não deu para ler o banco</p>
        <p className="text-muted max-w-sm text-sm">{error}</p>
        <button
          onClick={load}
          className="bg-sunken hover:bg-line inline-flex items-center gap-2 rounded-[var(--radius-control)] px-3 py-1.5 text-sm font-medium"
        >
          <RefreshCw className="h-4 w-4" /> Tentar de novo
        </button>
      </div>
    )
  }

  if (!overview) {
    return (
      <div className="bg-surface flex h-full items-center justify-center rounded-[var(--radius-inner)]">
        <Loader2 className="text-muted h-6 w-6 animate-spin" />
      </div>
    )
  }

  return (
    <div className="bg-surface flex h-full min-h-0 overflow-hidden rounded-[var(--radius-inner)]">
      {/* Lista: tabelas + funções */}
      <div className="w-56 shrink-0 overflow-y-auto p-3">
        <div className="text-muted mb-2 flex items-center justify-between text-xs font-semibold tracking-wide uppercase">
          Tabelas
          <button
            onClick={load}
            title="Recarregar"
            className="text-muted hover:text-ink"
          >
            <RefreshCw
              className={cn('h-3.5 w-3.5', loading && 'animate-spin')}
            />
          </button>
        </div>

        {overview.tables.length === 0 ? (
          <p className="text-muted text-xs">Nenhuma tabela ainda.</p>
        ) : (
          <ul className="space-y-0.5">
            {overview.tables.map((table) => (
              <li key={table.name}>
                <button
                  onClick={() => setSelected(table.name)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-[var(--radius-control)] px-2 py-1.5 text-left text-sm transition-colors',
                    selected === table.name
                      ? 'bg-accent text-accent-ink'
                      : 'text-ink hover:bg-sunken',
                  )}
                >
                  <Table2 className="h-4 w-4 shrink-0 opacity-70" />
                  <span className="flex-1 truncate">{table.name}</span>
                  {table.rlsEnabled ? (
                    <ShieldCheck className="h-3.5 w-3.5 shrink-0 opacity-70" />
                  ) : (
                    <ShieldOff className="text-down-ink h-3.5 w-3.5 shrink-0" />
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}

        {overview.functions.length > 0 && (
          <>
            <div className="text-muted mt-4 mb-2 text-xs font-semibold tracking-wide uppercase">
              Edge Functions
            </div>
            <ul className="space-y-0.5">
              {overview.functions.map((fn) => (
                <li
                  key={fn.slug}
                  className="text-ink flex items-center gap-2 px-2 py-1.5 text-sm"
                >
                  <FunctionSquare className="h-4 w-4 shrink-0 opacity-70" />
                  <span className="flex-1 truncate">{fn.name}</span>
                  <span className="text-muted text-[10px]">{fn.status}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      {/* Detalhe da tabela */}
      <div className="bg-sunken min-w-0 flex-1 overflow-y-auto">
        {selected ? (
          // key por tabela: remonta com estado limpo ao trocar, sem precisar
          // resetar estado dentro do efeito (o que dispara render em cascata).
          <TableDetailView
            key={selected}
            projectId={projectId}
            table={selected}
          />
        ) : (
          <div className="text-muted flex h-full items-center justify-center text-sm">
            Escolha uma tabela.
          </div>
        )}
      </div>
    </div>
  )
}

function TableDetailView({
  projectId,
  table,
}: {
  projectId: string
  table: string
}) {
  const [detail, setDetail] = useState<TableDetail | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    getTableDetail(projectId, table).then((result) => {
      if (!active) return
      if (result.error) setError(result.error)
      else setDetail(result.data ?? null)
    })
    return () => {
      active = false
    }
  }, [projectId, table])

  if (!detail && !error) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="text-muted h-5 w-5 animate-spin" />
      </div>
    )
  }
  if (error) {
    return <p className="text-down-ink p-5 text-sm">{error}</p>
  }
  if (!detail) return null

  return (
    <div className="space-y-6 p-5">
      <h2 className="flex items-center gap-2 text-lg font-semibold">
        <Table2 className="h-5 w-5" />
        {table}
      </h2>

      {/* Colunas */}
      <section>
        <h3 className="text-muted mb-2 text-xs font-semibold tracking-wide uppercase">
          Colunas
        </h3>
        <div className="bg-surface overflow-hidden rounded-[var(--radius-control)]">
          {detail.columns.map((col, i) => (
            <div
              key={col.name}
              className={cn(
                'flex items-center gap-3 px-3 py-2 text-sm',
                i > 0 && 'border-line border-t',
              )}
            >
              {col.isPrimaryKey && (
                <KeyRound className="text-wait-ink h-3.5 w-3.5 shrink-0" />
              )}
              <span className="font-mono font-medium">{col.name}</span>
              <span className="text-muted">{col.type}</span>
              {!col.nullable && (
                <span className="text-muted text-[10px] tracking-wide uppercase">
                  not null
                </span>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* RLS */}
      <section>
        <h3 className="text-muted mb-2 flex items-center gap-1.5 text-xs font-semibold tracking-wide uppercase">
          <ShieldCheck className="h-3.5 w-3.5" />
          Row Level Security
        </h3>
        {detail.policies.length === 0 ? (
          <p className="text-down-ink text-sm">
            Nenhuma policy. Sem policy, com RLS ligado, a tabela nega tudo — com
            RLS desligado, ela vaza. Verifique.
          </p>
        ) : (
          <div className="space-y-2">
            {detail.policies.map((policy) => (
              <div
                key={policy.name}
                className="bg-surface rounded-[var(--radius-control)] p-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{policy.name}</span>
                  <span className="bg-info text-info-ink rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-wide uppercase">
                    {policy.command}
                  </span>
                </div>
                {policy.using && (
                  <p className="text-muted mt-1.5 font-mono text-xs">
                    USING {policy.using}
                  </p>
                )}
                {policy.withCheck && (
                  <p className="text-muted mt-0.5 font-mono text-xs">
                    WITH CHECK {policy.withCheck}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Linhas */}
      <section>
        <h3 className="text-muted mb-2 text-xs font-semibold tracking-wide uppercase">
          Linhas ({detail.data.rows.length})
        </h3>
        {detail.data.rows.length === 0 ? (
          <p className="text-muted text-sm">Tabela vazia.</p>
        ) : (
          <div className="bg-surface overflow-x-auto rounded-[var(--radius-control)]">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="text-muted">
                  {detail.data.columns.map((col) => (
                    <th
                      key={col}
                      className="border-line border-b px-3 py-2 font-medium"
                    >
                      {col}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {detail.data.rows.map((row, i) => (
                  <tr key={i} className="border-line border-b last:border-0">
                    {detail.data.columns.map((col) => (
                      <td
                        key={col}
                        className="text-ink max-w-[16rem] truncate px-3 py-2 font-mono"
                      >
                        {formatCell(row[col])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}
