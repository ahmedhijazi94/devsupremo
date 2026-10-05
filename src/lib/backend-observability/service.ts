import { usageLimitsSchema, usageSnapshotSchema, type UsageLimit, type UsageReport, type UsageSnapshot } from './contract'

export function usageAlerts(current: UsageSnapshot, limits: UsageLimit[]): UsageReport['alerts'] {
  const observation = usageSnapshotSchema.parse(current)
  return usageLimitsSchema.parse(limits).map(limit => {
    const metric = observation.metrics.find(metric => metric.name === limit.metric)
    const value = metric?.available ? metric.value : null
    return { ...limit, value, state: value === null ? 'unavailable' : value >= limit.maximum ? 'limit_reached' : 'within_limit' }
  })
}
export function usageHour(observedAt: string): string {
  const date = new Date(observedAt)
  if (!Number.isFinite(date.getTime())) throw new Error('Data de observação inválida.')
  date.setUTCMinutes(0, 0, 0)
  return date.toISOString()
}
