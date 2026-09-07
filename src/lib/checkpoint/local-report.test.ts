import { describe, expect, it } from 'vitest'
import { localCheckpointPresentation, localCheckpointReportSchema, readLocalReportBody } from './local-report'

const payload = {
  deviceSecret: 'device-example-not-a-credential',
  projectId: '11111111-1111-4111-8111-111111111111',
  checkpointId: '22222222-2222-4222-8222-222222222222',
  commitSha: 'a'.repeat(40), createdAt: '2026-09-06T00:00:00.000Z', revision: 1,
  validationStatus: 'failed', validatedSha: 'a'.repeat(40), uploadStatus: 'local',
}

describe('checkpoint status reporting contract', () => {
  it('allows failed local work without requiring code publication', () => {
    expect(localCheckpointReportSchema.parse(payload)).toEqual(payload)
  })
  it.each([
    { summary: 'private prompt' }, { logs: 'private log' }, { files: ['private'] },
    { commitSha: 'invalid' }, { validatedSha: 'b'.repeat(40) },
    { validationStatus: 'passed', validatedSha: null },
    { validationStatus: 'deferred', validatedSha: null },
    { uploadStatus: 'integrated' }, { projectId: 'not-a-uuid' }, { revision: 0 },
    { deviceSecret: 'x'.repeat(257) },
  ])('rejects unbounded data, credentials, foreign evidence or a forged approval: %j', (patch) => {
    expect(localCheckpointReportSchema.safeParse({ ...payload, ...patch }).success).toBe(false)
  })
  it('never presents local success/deferred QA as a passed CI gate', () => {
    expect(localCheckpointPresentation('passed', 'local').state).toBe('pending')
    expect(localCheckpointPresentation('deferred', 'upload_pending').state).toBe('pending')
    expect(localCheckpointPresentation('failed', 'local')).toMatchObject({ state: 'failed', label: 'Pendência local' })
    expect(localCheckpointPresentation('passed', 'push_failed').label).toBe('Envio interrompido')
    expect(localCheckpointPresentation('running', 'local').label).toBe('Salvo no computador')
    expect(localCheckpointPresentation('pending', 'local').label).toBe('Salvo no computador')
  })
  it('parses bounded JSON and fails closed for malformed, missing, declared or streamed oversized bodies', async () => {
    const request = (body?: string, headers?: Record<string, string>) => new Request('https://supremo.test/api/checkpoint/local-report', { method: 'POST', ...(body === undefined ? {} : { body }), ...(headers ? { headers } : {}) })
    expect(await readLocalReportBody(request(JSON.stringify(payload)))).toEqual(payload)
    expect(await readLocalReportBody(request('{'))).toBeNull()
    expect(await readLocalReportBody(request())).toBeNull()
    expect(await readLocalReportBody(request('{}', { 'content-length': '4097' }))).toBeNull()
    expect(await readLocalReportBody(request('x'.repeat(4097)))).toBeNull()
  })
})
