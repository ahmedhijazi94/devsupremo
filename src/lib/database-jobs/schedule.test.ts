import { describe, expect, it } from 'vitest'
import { dailySchedule, jobTimezoneSchema, nextDailyRuns } from './schedule'
import { jobsManifestSchema, jobsRequestSchema } from './policy'
import { localDailyCommand, runNowSql } from './execution-sql'
const project = '11111111-1111-4111-8111-111111111111', operationId = '22222222-2222-4222-8222-222222222222'
describe('daily local jobs', () => {
  it('shows actual local occurrences across spring gaps and autumn folds', () => {
    expect(nextDailyRuns('30 2 * * *', 'America/New_York', new Date('2026-03-07T08:00:00Z'), 2)).toEqual(['2026-03-09T06:30:00.000Z', '2026-03-10T06:30:00.000Z'])
    expect(nextDailyRuns('30 1 * * *', 'America/New_York', new Date('2026-11-01T04:00:00Z'), 2)).toEqual(['2026-11-01T05:30:00.000Z', '2026-11-02T06:30:00.000Z'])
    expect(nextDailyRuns('30 1 * * *', 'America/New_York', new Date('2026-11-01T06:00:00Z'), 1)).toEqual(['2026-11-02T06:30:00.000Z'])
    expect(nextDailyRuns('0 9 * * *', 'America/Porto_Velho', new Date('2026-10-05T12:00:00Z'), 1)).toEqual(['2026-10-05T13:00:00.000Z'])
  })
  it('rejects unsupported timezones and complex local expressions', () => {
    expect(jobTimezoneSchema.safeParse('invalid/zone').success).toBe(false)
    for (const schedule of ['60 9 * * *', '0 24 * * *', '*/5 * * * *']) expect(dailySchedule(schedule)).toBeNull()
    expect(() => nextDailyRuns('* * * * *', 'UTC', new Date())).toThrow()
    expect(() => nextDailyRuns('0 9 * * *', 'UTC', new Date('invalid'))).toThrow()
    const job = { id: 'daily', schedule: '*/5 * * * *', timezone: 'America/New_York', action: { type: 'function', slug: 'daily', body: {} } }
    expect(() => jobsManifestSchema.parse({ version: 1, jobs: [job] })).toThrow('Fusos locais')
  })
  it('requires durable request identity for immediate execution', () => {
    const request = { projectId: project, expectedRef: 'fixture', environment: 'development', deviceSecret: 'fixture-secret', operation: 'cron-run-now', jobId: 'daily', operationId }
    expect(jobsRequestSchema.parse(request).operationId).toBe(operationId)
    for (const patch of [{ operationId: undefined }, { jobId: undefined }]) expect(() => jobsRequestSchema.parse({ ...request, ...patch })).toThrow()
    expect(runNowSql(project, 'daily', operationId)).toContain('current_job.runnable_command')
    expect(localDailyCommand(project, 'daily', 'UTC', '0 9 * * *', 'SELECT 1')).toBe('SELECT 1')
    expect(() => localDailyCommand(project, 'daily', 'America/New_York', '* * * * *', 'SELECT 1')).toThrow()
  })
})
