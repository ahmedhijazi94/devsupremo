import { describe, expect, it } from 'vitest'
import { backendTurnContextSchema, turnContextRequestSchema, type BackendTurnContext } from './turn-context'
import { buildValidationFeedback } from './feedback'

const projectId = '11111111-1111-4111-8111-111111111111'
const checkpointId = '22222222-2222-4222-8222-222222222222'
const differentId = '33333333-3333-4333-8333-333333333333'
const failure = buildValidationFeedback({
  projectId, checkpointId, commitSha: 'a'.repeat(40), publishedSha: 'b'.repeat(40), checksSha: 'b'.repeat(40),
  observedAt: '2026-09-06T01:00:00.000Z', required: ['tests'], integrated: false,
  checks: [{ name: 'tests', status: 'completed', conclusion: 'failure' }], evidence: 'Expected user isolation.',
})
const valid: BackendTurnContext = {
  version: 1, projectId, project: { id: projectId, name: 'Chamados' },
  repository: { fullName: 'team/chamados', url: 'https://github.com/team/chamados.git', branch: 'main', defaultBranch: 'main' },
  environment: 'development', databaseEnvironment: 'development',
  databaseAuthority: { projectRef: 'dev-ref', source: 'supremo_provisioned', automaticMigrations: true },
  latestCheckpoint: { id: checkpointId, localSha: failure.commitSha, publishedSha: failure.publishedSha, pushStatus: 'published', integrationStatus: 'ci_failed', integrationBranch: 'supremo/work', createdAt: failure.observedAt },
  feedback: { current: failure, previousFailure: null }, observedAt: failure.observedAt,
}

describe('backend turn context contract', () => {
  it('accepts server evidence whose project, checkpoint and both SHAs agree', () => {
    expect(backendTurnContextSchema.parse(valid)).toEqual(valid)
    expect(backendTurnContextSchema.parse({ ...valid, latestCheckpoint: null, feedback: { current: null, previousFailure: failure } }).feedback.previousFailure).toEqual(failure)
  })
  it('only accepts identity credentials as preflight input', () => {
    expect(turnContextRequestSchema.safeParse({ projectId, deviceSecret: 'sup_dev_ckpt_secret' }).success).toBe(true)
    expect(turnContextRequestSchema.safeParse({ projectId, deviceSecret: 'sup_dev_ckpt_secret', publishedSha: failure.publishedSha }).success).toBe(false)
  })
  it.each([
    { project: { ...valid.project, id: differentId } },
    { environment: 'production' },
    { databaseAuthority: { ...valid.databaseAuthority, projectRef: null } },
    { databaseAuthority: { ...valid.databaseAuthority, source: null } },
    { environment: 'production', databaseEnvironment: 'production' },
    { latestCheckpoint: null },
    { latestCheckpoint: { ...valid.latestCheckpoint, id: differentId } },
    { latestCheckpoint: { ...valid.latestCheckpoint, localSha: 'c'.repeat(40) } },
    { latestCheckpoint: { ...valid.latestCheckpoint, publishedSha: 'c'.repeat(40) } },
    { feedback: { current: { ...failure, projectId: differentId }, previousFailure: null } },
    { feedback: { current: null, previousFailure: { ...failure, projectId: differentId } } },
    { feedback: { current: null, previousFailure: { ...failure, state: 'passed' } } },
    { feedback: { current: null, previousFailure: null } },
    { feedback: { current: { ...failure, state: 'pending' }, previousFailure: failure } },
    { latestCheckpoint: { ...valid.latestCheckpoint, integrationStatus: 'security_blocked' }, feedback: { current: null, previousFailure: null } },
  ])('refuses contradictory authority or evidence: %j', (patch) => {
    expect(backendTurnContextSchema.safeParse({ ...valid, ...patch }).success).toBe(false)
  })
})
