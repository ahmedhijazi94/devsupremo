import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { JobsProvider } from '@/lib/database-jobs/provider'
import type { JobsRequest } from '@/lib/database-jobs/policy'

const mocks = vi.hoisted(() => ({ user: vi.fn(), project: vi.fn(), environment: vi.fn(), credentials: vi.fn(), query: vi.fn(), logs: vi.fn(), audit: vi.fn(), jobs: vi.fn(), functions: vi.fn() }))
vi.mock('@/lib/auth', () => ({ requireUser: mocks.user }))
vi.mock('@/lib/supabase/admin', () => ({ createServiceClient: () => ({ from: (table: string) => { if (table !== 'audit_logs') throw new Error('Unexpected table'); return { insert: mocks.audit } } }) }))
vi.mock('@/lib/projects/repository', () => ({ getProject: mocks.project, getSupabaseCredentials: mocks.credentials }))
vi.mock('@/lib/database-environment/store', () => ({ readEnvironment: mocks.environment }))
vi.mock('@/lib/database-inspection/provider', async (original) => {
  const actual = await original<typeof import('@/lib/database-inspection/provider')>()
  return { ...actual, supabaseInspectionProvider: (resolve: () => Promise<unknown>) => ({
    query: async (sql: string) => { await resolve(); return mocks.query(sql) },
    logs: async (parameters: URLSearchParams) => { await resolve(); return mocks.logs(parameters) },
  }) }
})
vi.mock('@/lib/database-jobs/provider', async (original) => {
  const actual = await original<typeof import('@/lib/database-jobs/provider')>()
  return { ...actual, supabaseJobsProvider: (resolve: (readOnly: boolean) => Promise<unknown>) => ({
    query: async (_sql: string, options: { readOnly: boolean }) => { await resolve(options.readOnly); return [] },
  }) }
})
vi.mock('@/lib/database-jobs/service', () => ({ runJobs: async (provider: JobsProvider, input: JobsRequest) => {
  await provider.query('generated-in-service', { readOnly: !['cron-pause', 'cron-resume'].includes(input.operation) })
  return mocks.jobs(input)
} }))
vi.mock('@/lib/edge-functions/server', () => ({ runAuthorizedFunctions: mocks.functions }))

import { runProjectBackend } from './project-backend'
import { InspectionError } from '@/lib/database-inspection/provider'

const projectId = '11111111-1111-4111-8111-111111111111'
const ownerId = 'owner-session'
const token = 'fixture-private-management-token'
const target = { projectRef: 'boundproject', environment: 'development' as const }
const input = { projectId, operation: 'rows' as const, table: 'expenses' }
const job = { projectId, operation: 'job-set-active' as const, jobId: 'daily-summary', enabled: false, expectedRef: target.projectRef, environment: target.environment }

beforeEach(() => {
  vi.resetAllMocks()
  mocks.user.mockResolvedValue({ user: { id: ownerId } })
  mocks.project.mockResolvedValue({ supabase_project_ref: target.projectRef, supabase_account_id: 'owned-account' })
  mocks.environment.mockResolvedValue({ project_ref: target.projectRef, environment: 'development', source: 'supremo_provisioned' })
  mocks.credentials.mockResolvedValue({ projectRef: target.projectRef, token })
  mocks.query.mockResolvedValue([{ id: 1, description: 'Expense' }])
  mocks.logs.mockResolvedValue([])
  mocks.audit.mockResolvedValue({ error: null })
  mocks.jobs.mockResolvedValue({ available: true, applied: true, jobId: job.jobId })
})

describe('project backend owner action', () => {
  it('requires a session before resolving project credentials or provider data', async () => {
    mocks.user.mockRejectedValue(new Error(`Unauthenticated ${token}`))
    expect(await runProjectBackend(input)).toEqual({ ok: false, error: expect.not.stringContaining(token) })
    expect(mocks.project).not.toHaveBeenCalled(); expect(mocks.credentials).not.toHaveBeenCalled(); expect(mocks.query).not.toHaveBeenCalled()
  })

  it('uses only the authenticated owner and rejects a foreign project before credential access', async () => {
    mocks.project.mockRejectedValue(new Error('Project unavailable'))
    expect(await runProjectBackend(input)).toMatchObject({ ok: false })
    expect(mocks.project).toHaveBeenCalledWith(ownerId, projectId)
    expect(mocks.credentials).not.toHaveBeenCalled(); expect(mocks.query).not.toHaveBeenCalled(); expect(mocks.functions).not.toHaveBeenCalled()
  })

  it('rejects forged owner, device credentials and mutation targets before authentication', async () => {
    expect(await runProjectBackend({ ...input, ownerId: 'another' } as typeof input)).toMatchObject({ ok: false })
    expect(await runProjectBackend({ ...input, deviceSecret: 'injected-device-secret' } as typeof input)).toMatchObject({ ok: false })
    expect(await runProjectBackend({ ...job, expectedRef: undefined } as unknown as typeof job)).toMatchObject({ ok: false })
    expect(mocks.user).not.toHaveBeenCalled()
  })

  it('redacts protected columns and token occurrences from successful reads', async () => {
    mocks.query.mockResolvedValue([{ description: `prose ${token}`, api_key: 'fixture-secret-key', amount: 25 }])
    const result = await runProjectBackend(input)
    expect(result).toMatchObject({ ok: true, ...target, data: { items: [{ description: 'prose [REDACTED]', api_key: '[REDACTED]', amount: 25 }] } })
    expect(JSON.stringify(result)).not.toContain(token)
    expect(JSON.stringify(result)).not.toContain('fixture-secret-key')
    expect(mocks.credentials).toHaveBeenCalledWith(ownerId, expect.objectContaining({ supabase_account_id: 'owned-account' }))
  })

  it('revalidates session identity after reading without returning stale data', async () => {
    mocks.query.mockImplementation(async () => { mocks.user.mockResolvedValue({ user: { id: 'another-session' } }); return [{ description: 'private-result' }] })
    const result = await runProjectBackend(input)
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('sessão mudou') })
    expect(JSON.stringify(result)).not.toContain('private-result')
  })

  it('does not return a result if the project account changes while reading', async () => {
    mocks.query.mockImplementation(async () => { mocks.project.mockResolvedValue({ supabase_project_ref: target.projectRef, supabase_account_id: 'replacement-account' }); return [{ description: 'private-result' }] })
    const result = await runProjectBackend(input)
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('mudou') })
    expect(JSON.stringify(result)).not.toContain('private-result')
  })

  it('fails closed when the mutation audit cannot be persisted', async () => {
    mocks.audit.mockResolvedValue({ error: { message: token } })
    const result = await runProjectBackend(job)
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('não foi alterado') })
    expect(JSON.stringify(result)).not.toContain(token)
    expect(mocks.jobs).not.toHaveBeenCalled(); expect(mocks.credentials).not.toHaveBeenCalled()
  })

  it('audits the confirmed destination before calling a job mutation', async () => {
    const result = await runProjectBackend(job)
    expect(result).toMatchObject({ ok: true, data: { message: 'Agendamento pausado.' } })
    expect(mocks.audit).toHaveBeenCalledWith({ user_id: ownerId, action: 'cron-pause.requested', resource_type: 'project', resource_id: projectId, metadata: { jobId: job.jobId, targetRef: target.projectRef, environment: target.environment, source: 'backend_console' }, ip_address: null })
    expect(mocks.audit.mock.invocationCallOrder[0]).toBeLessThan(mocks.jobs.mock.invocationCallOrder[0]!)
    expect(mocks.jobs).toHaveBeenCalledWith(expect.objectContaining({ operation: 'cron-pause', projectId, expectedRef: target.projectRef, environment: target.environment, jobId: job.jobId }))
  })

  it('refuses a changed target before writing an audit or changing the job', async () => {
    expect(await runProjectBackend({ ...job, expectedRef: 'different-project' })).toMatchObject({ ok: false })
    expect(mocks.audit).not.toHaveBeenCalled(); expect(mocks.jobs).not.toHaveBeenCalled()
  })

  it('passes safe errors through redaction and masks unknown provider failures', async () => {
    mocks.query.mockRejectedValueOnce(new InspectionError(`Provider ${token} unavailable.`))
    const safe = await runProjectBackend(input)
    expect(safe).toEqual({ ok: false, error: 'Provider [REDACTED] unavailable.' })
    mocks.query.mockRejectedValueOnce(new Error(`Raw provider body ${token}`))
    const unknown = await runProjectBackend(input)
    expect(unknown).toEqual({ ok: false, error: expect.not.stringContaining('Raw provider body') })
  })

  it('keeps SQL writes outside the editor provider', async () => {
    expect(await runProjectBackend({ projectId, operation: 'query', sql: 'DELETE FROM public.expenses' })).toMatchObject({ ok: false })
    expect(mocks.query).not.toHaveBeenCalled(); expect(mocks.credentials).not.toHaveBeenCalled()
  })
})
