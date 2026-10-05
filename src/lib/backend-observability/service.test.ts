import { describe, expect, it } from 'vitest'
import { usageAlerts, usageHour } from './service'
import { usageLimitsSchema, usageReadSchema, usageSnapshotSchema } from './contract'
const current = { observedAt: '2026-10-05T10:00:00.000Z', metrics: [
  { name: 'Tamanho do banco', value: 100, available: true }, { name: 'Conexões atuais', value: 0, available: true }, { name: 'Arquivos armazenados', value: null, available: false },
] }
describe('truthful collected usage', () => {
  it('distinguishes measured zero, missing reads and crossed thresholds including exact equality', () => {
    expect(usageAlerts(current, [ { metric: 'Tamanho do banco', maximum: 100 }, { metric: 'Conexões atuais', maximum: 1 }, { metric: 'Arquivos armazenados', maximum: 1 }, { metric: 'Registros estimados', maximum: 1 } ])).toEqual([
      { metric: 'Tamanho do banco', maximum: 100, value: 100, state: 'limit_reached' }, { metric: 'Conexões atuais', maximum: 1, value: 0, state: 'within_limit' },
      { metric: 'Arquivos armazenados', maximum: 1, value: null, state: 'unavailable' }, { metric: 'Registros estimados', maximum: 1, value: null, state: 'unavailable' },
    ])
    expect(usageAlerts(current, [])).toEqual([])
  })
  it('rejects unavailable values masquerading as zero, invalid thresholds and duplicate metrics', () => {
    for (const metric of [{ name: 'bad', value: 0, available: false }, { name: 'bad', value: null, available: true }, { name: 'bad', value: -1, available: true }]) expect(usageSnapshotSchema.safeParse({ ...current, metrics: [metric] }).success).toBe(false)
    for (const maximum of [0, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) expect(usageLimitsSchema.safeParse([{ metric: 'Tamanho do banco', maximum }]).success).toBe(false)
    expect(usageLimitsSchema.safeParse([{ metric: 'Fatura em reais', maximum: 10 }]).success).toBe(false)
    expect(usageLimitsSchema.safeParse([{ metric: 'Conexões atuais', maximum: 10 }, { metric: 'Conexões atuais', maximum: 20 }]).success).toBe(false)
  })
  it('bounds retained history and assigns a UTC hour without inventing missing observations', () => {
    expect(usageHour('2026-10-05T09:31:59-04:00')).toBe('2026-10-05T13:00:00.000Z')
    expect(() => usageHour('invalid')).toThrow()
    const scope = { projectId: '11111111-1111-4111-8111-111111111111', expectedRef: 'owned', environment: 'development' }
    expect(usageReadSchema.parse(scope).days).toBe(7)
    for (const patch of [{ days: 31 }, { days: 0 }, { ownerSession: true }, { expectedRef: 'https://evil' }, { environment: 'unknown' }]) expect(usageReadSchema.safeParse({ ...scope, ...patch }).success).toBe(false)
  })
})
