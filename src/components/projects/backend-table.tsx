'use client'

export type BackendRow = Record<string, unknown>

function CellValue({ value }: { value: unknown }) {
  if (value === null || value === undefined)
    return <span className="text-muted">—</span>
  if (typeof value === 'boolean') return <span>{value ? 'Sim' : 'Não'}</span>
  const text =
    typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value)
  if (text.length > 180 || typeof value === 'object')
    return (
      <details>
        <summary className="cursor-pointer text-xs underline">
          Ver conteúdo
        </summary>
        <pre className="mt-2 max-w-xl font-mono text-xs break-all whitespace-pre-wrap">
          {text}
        </pre>
      </details>
    )
  return <span className="break-words">{text}</span>
}

export function BackendTable({
  rows,
  columns,
  caption,
  empty = 'Nenhum registro encontrado.',
}: {
  rows: BackendRow[]
  columns?: string[] | undefined
  caption: string
  empty?: string
}) {
  const displayedColumns = columns?.length
    ? columns
    : Array.from(new Set(rows.flatMap((row) => Object.keys(row))))
  if (!rows.length)
    return (
      <p className="text-muted bg-sunken rounded-xl p-5 text-sm" role="status">
        {empty}
      </p>
    )
  return (
    <div
      className="border-line overflow-x-auto rounded-xl border"
      tabIndex={0}
      role="region"
      aria-label={caption}
    >
      <table className="w-full border-collapse text-left text-xs">
        <caption className="sr-only">{caption}</caption>
        <thead className="bg-sunken text-ink-soft">
          <tr>
            {displayedColumns.map((column) => (
              <th
                key={column}
                scope="col"
                className="px-4 py-3 font-medium whitespace-nowrap"
              >
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index} className="border-line border-t">
              {displayedColumns.map((column) => (
                <td
                  key={column}
                  className="max-w-80 min-w-28 px-4 py-3 align-top"
                >
                  <CellValue value={row[column]} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function BackendPagination({
  label = 'Paginação de registros',
  offset,
  count,
  limit,
  hasMore,
  onChange,
  pending = false,
}: {
  label?: string
  offset: number
  count: number
  limit: number
  hasMore: boolean
  pending?: boolean
  onChange: (offset: number) => void
}) {
  return (
    <div
      aria-label={label}
      role="group"
      className="mt-4 flex flex-wrap items-center justify-between gap-3 text-xs"
    >
      <span className="text-muted">
        {count
          ? `${offset + 1}–${offset + count}`
          : 'Nenhum registro nesta página'}
      </span>
      <div className="flex gap-2">
        <button
          type="button"
          className="bg-sunken rounded-lg px-3 py-2 disabled:opacity-40"
          disabled={pending || offset === 0}
          onClick={() => onChange(Math.max(0, offset - limit))}
        >
          Anterior
        </button>
        <button
          type="button"
          className="bg-sunken rounded-lg px-3 py-2 disabled:opacity-40"
          disabled={pending || !hasMore}
          onClick={() => onChange(offset + limit)}
        >
          Próxima
        </button>
      </div>
    </div>
  )
}
