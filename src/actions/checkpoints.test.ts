import { beforeEach, describe, expect, it, vi } from 'vitest'
import { listProjectCheckpoints } from './checkpoints'

const mocks = vi.hoisted(() => ({ limit: vi.fn() }))
vi.mock('@/lib/auth', () => ({
  requireUser: async () => ({ supabase: { from: () => ({ select: () => ({ eq: () => ({ order: () => ({ limit: mocks.limit }) }) }) }) } }),
  toActionError: (error: unknown) => String(error),
}))

const projectId = '4164e3fc-3722-4247-9a3e-43c05203b9d3'
const checkpointId = '24891f34-9a58-4b0f-9a53-24a1f7d97f0a'
const commitSha = 'a'.repeat(40)
const publishedSha = 'b'.repeat(40)
const feedback = {
  projectId, checkpointId, commitSha, publishedSha,
  observedAt: '2026-09-08T20:05:00.000Z', state: 'passed',
  failures: [], checks: [{ name: 'Build', status: 'passed' }],
  summary: 'Validação aprovada. Aguardando integração.', evidence: '',
}
const checkpoint = {
  id: checkpointId, project_id: projectId, commit_sha: commitSha, published_sha: publishedSha,
  push_status: 'published', integration_status: 'ci_running', summary: 'Despesas', risk_level: 'high',
  created_at: '2026-09-08T20:01:00.000Z', validation_feedback: feedback, migrations: [], pr_number: 1,
}
beforeEach(() => { vi.clearAllMocks() })

describe('histórico diferencia testes aprovados de integração confirmada', () => {
  it('a revisão publicada aprovada aguarda integração, mesmo com status antigo ci_running', async () => {
    mocks.limit.mockResolvedValue({ data: [checkpoint], error: null })
    const result = await listProjectCheckpoints(projectId)
    expect(result.items?.[0]).toMatchObject({ status: 'Aguardando integração', validationSummary: feedback.summary, canRestore: true })
    expect(result.items?.[0]?.status).not.toBe('Integrado')
  })

  it.each([
    { projectId: 'f164e3fc-3722-4247-9a3e-43c05203b9d3' },
    { checkpointId: 'f4891f34-9a58-4b0f-9a53-24a1f7d97f0a' },
    { commitSha: 'c'.repeat(40) },
    { publishedSha: 'd'.repeat(40) },
  ])('evidência de outro alvo/revisão não encerra os testes atuais (%j)', async (mismatch) => {
    mocks.limit.mockResolvedValue({ data: [{ ...checkpoint, validation_feedback: { ...feedback, ...mismatch } }], error: null })
    expect((await listProjectCheckpoints(projectId)).items?.[0]).toMatchObject({ status: 'Testando', validationSummary: '' })
  })

  it('evidência que ainda tem check pendente não aprova a revisão', async () => {
    mocks.limit.mockResolvedValue({ data: [{ ...checkpoint, validation_feedback: { ...feedback, checks: [{ name: 'Build', status: 'pending' }] } }], error: null })
    expect((await listProjectCheckpoints(projectId)).items?.[0]?.status).toBe('Testando')
  })

  it('validação aprovada não mascara o bloqueio independente de segurança', async () => {
    mocks.limit.mockResolvedValue({ data: [{ ...checkpoint, integration_status: 'security_blocked' }], error: null })
    expect((await listProjectCheckpoints(projectId)).items?.[0]).toMatchObject({ status: 'Falhou', validationLabel: 'Validação bloqueada' })
  })

  it('somente o estado confirmado de integração apresenta Integrado', async () => {
    mocks.limit.mockResolvedValue({ data: [{ ...checkpoint, push_status: 'integrated', integration_status: 'merged' }], error: null })
    expect((await listProjectCheckpoints(projectId)).items?.[0]?.status).toBe('Integrado')
  })
})
