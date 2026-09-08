import { createHash } from 'node:crypto'
import type { JobDefinition } from './policy'
import { quoteIdent, quoteLiteral, type JobTable } from './catalog'

const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex')
export function jobNames(projectId: string, id: string) {
  const hash = digest(`${projectId}:${id}`).slice(0, 24)
  return {
    key: `supremo:${projectId}:${id}`,
    role: `supremo_job_${hash}`,
    policy: `supremo_job_${hash}`,
  }
}
export function valueSql(value: string | number | boolean | null): string {
  return value === null
    ? 'NULL'
    : typeof value === 'string'
      ? quoteLiteral(value)
      : typeof value === 'boolean'
        ? value
          ? 'TRUE'
          : 'FALSE'
        : String(value)
}
export function compileJob(
  projectId: string,
  job: JobDefinition,
  table: JobTable,
) {
  const names = jobNames(projectId, job.id)
  const key = quoteIdent(table.primary_key[0]!)
  const relation = `public.${quoteIdent(job.action.table)}`
  const filters = job.action.where
    .map((condition) => {
      const column = `t.${quoteIdent(condition.column)}`
      if (condition.op === 'is_null') return `${column} IS NULL`
      if (condition.op === 'not_null') return `${column} IS NOT NULL`
      if (condition.op === 'older_than')
        return `${column} < pg_catalog.now() - INTERVAL '${condition.minutes} minutes'`
      return `${column} IS ${condition.op === 'eq' ? 'NOT ' : ''}DISTINCT FROM ${valueSql(condition.value)}`
    })
    .join(' AND ')
  const body = `WITH picked AS (SELECT t.${key} FROM ONLY ${relation} t WHERE ${filters} ORDER BY t.${key} LIMIT ${job.action.limit} FOR UPDATE SKIP LOCKED), changed AS (UPDATE ONLY ${relation} t SET ${Object.entries(
    job.action.set,
  )
    .map(([name, value]) => `${quoteIdent(name)}=${valueSql(value)}`)
    .join(
      ',',
    )} FROM picked WHERE t.${key}=picked.${key} RETURNING 1) SELECT pg_catalog.count(*)::bigint FROM changed`
  const bodyHash = digest(body)
  const manifestHash = digest(JSON.stringify(job))
  return {
    ...names,
    definition: job,
    table,
    body,
    bodyHash,
    manifestHash,
    wrapper: `run_${digest(names.key).slice(0, 16)}_${bodyHash.slice(0, 16)}`,
    selectColumns: [
      ...new Set([
        table.primary_key[0]!,
        ...job.action.where.map((condition) => condition.column),
      ]),
    ],
    updateColumns: Object.keys(job.action.set),
  }
}
export type CompiledJob = ReturnType<typeof compileJob>
