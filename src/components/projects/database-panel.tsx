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
  Trash2,
} from 'lucide-react'
import {
  getDatabaseOverview,
  getTableDetail,
  updateCell,
  deleteRow,
  type DatabaseOverview,
  type TableDetail,
} from '@/actions/database'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'

/**
 * A aba do banco: tabelas, colunas, policies de RLS e Edge Functions, direto
 * no Supremo. É a prova visível do que o agente construiu — e do isolamento
 * (as policies aparecem por tabela). As linhas dão para editar em tabela com
 * chave primária, com o mesmo guard de dado do MCP; estrutura continua só pelo
 * agente.
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

      {/* Linhas — editáveis */}
      <EditableRows
        projectId={projectId}
        table={table}
        columns={detail.data.columns}
        pkColumn={
          detail.columns.filter((c) => c.isPrimaryKey).length === 1
            ? (detail.columns.find((c) => c.isPrimaryKey)?.name ?? null)
            : null
        }
        rows={detail.data.rows}
      />
    </div>
  )
}

function EditableRows({
  projectId,
  table,
  columns,
  pkColumn,
  rows: initialRows,
}: {
  projectId: string
  table: string
  columns: string[]
  pkColumn: string | null
  rows: Array<Record<string, unknown>>
}) {
  const [rows, setRows] = useState(initialRows)
  const [editing, setEditing] = useState<{ pk: string; col: string } | null>(
    null,
  )
  const [draft, setDraft] = useState('')
  const [busy, startBusy] = useTransition()

  const editable = pkColumn !== null

  function save(pk: string) {
    if (!editing) return
    const { col } = editing
    const value = draft === '' ? null : draft
    startBusy(async () => {
      const result = await updateCell({
        projectId,
        table,
        pkColumn: pkColumn!,
        pkValue: pk,
        column: col,
        value,
      })
      if (result.error) {
        toast.error(result.error)
        return
      }
      setRows((prev) =>
        prev.map((r) =>
          String(r[pkColumn!]) === pk ? { ...r, [col]: value } : r,
        ),
      )
      setEditing(null)
      toast.success('Dado atualizado.')
    })
  }

  function remove(pk: string) {
    startBusy(async () => {
      const result = await deleteRow({
        projectId,
        table,
        pkColumn: pkColumn!,
        pkValue: pk,
      })
      if (result.error) {
        toast.error(result.error)
        return
      }
      setRows((prev) => prev.filter((r) => String(r[pkColumn!]) !== pk))
      toast.success('Linha removida.')
    })
  }

  return (
    <section>
      <h3 className="text-muted mb-2 text-xs font-semibold tracking-wide uppercase">
        Linhas ({rows.length})
      </h3>
      {!editable && rows.length > 0 && (
        <p className="text-muted mb-2 text-xs">
          Edição direta precisa de uma chave primária única — esta tabela não
          tem. Peça a alteração ao agente.
        </p>
      )}
      {rows.length === 0 ? (
        <p className="text-muted text-sm">Tabela vazia.</p>
      ) : (
        <div className="bg-surface overflow-x-auto rounded-[var(--radius-control)]">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="text-muted">
                {columns.map((col) => (
                  <th
                    key={col}
                    className="border-line border-b px-3 py-2 font-medium"
                  >
                    {col}
                  </th>
                ))}
                {editable && <th className="border-line border-b px-2" />}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const pk = editable ? String(row[pkColumn]) : ''
                return (
                  <tr
                    key={pk || JSON.stringify(row)}
                    className="border-line border-b last:border-0"
                  >
                    {columns.map((col) => {
                      const isEditing =
                        editing?.pk === pk && editing?.col === col
                      const isPk = col === pkColumn
                      return (
                        <td
                          key={col}
                          className="text-ink max-w-[16rem] px-3 py-1.5 font-mono"
                        >
                          {isEditing ? (
                            <input
                              autoFocus
                              value={draft}
                              disabled={busy}
                              onChange={(e) => setDraft(e.target.value)}
                              onBlur={() => save(pk)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') save(pk)
                                if (e.key === 'Escape') setEditing(null)
                              }}
                              className="bg-sunken w-full rounded px-1.5 py-0.5 outline-none"
                            />
                          ) : (
                            <button
                              type="button"
                              disabled={!editable || isPk}
                              onClick={() => {
                                setDraft(
                                  row[col] === null || row[col] === undefined
                                    ? ''
                                    : String(row[col]),
                                )
                                setEditing({ pk, col })
                              }}
                              className={cn(
                                'block max-w-full truncate text-left',
                                editable && !isPk
                                  ? 'hover:bg-sunken -mx-1 rounded px-1'
                                  : 'cursor-default',
                              )}
                              title={
                                editable && !isPk
                                  ? 'Clique para editar'
                                  : undefined
                              }
                            >
                              {formatCell(row[col])}
                            </button>
                          )}
                        </td>
                      )
                    })}
                    {editable && (
                      <td className="px-2">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => {
                            if (confirm('Remover esta linha?')) remove(pk)
                          }}
                          title="Remover linha"
                          className="text-muted hover:text-down-ink p-1"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}
