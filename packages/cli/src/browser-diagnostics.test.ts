import { afterEach, beforeEach, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { BROWSER_DIAGNOSTICS_PATH, readBrowserDiagnostics } from './browser-diagnostics'
import { turnAgentResponse } from './turn-response'
import type { TurnResult } from './turn-runtime'

const projectId = '11111111-1111-4111-8111-111111111111'
const now = Date.now()
const observation = { kind: 'error', name: 'TypeError', file: 'src/routes/index.tsx', generatedLine: 12, generatedColumn: 3, count: 2, firstSeenAt: now - 1000, lastSeenAt: now }
const valid = () => ({ version: 1, projectId, bootId: '22222222-2222-4222-8222-222222222222', startedAt: now - 2000, updatedAt: now, events: [observation] })
let root: string
function write(value: unknown) { fs.writeFileSync(path.join(root, BROWSER_DIAGNOSTICS_PATH), JSON.stringify(value)) }
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'supremo-browser-reader-')); fs.mkdirSync(path.join(root, '.supremo/runtime'), { recursive: true }) })
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

it('exposes only a bounded, informational summary for the matching project', () => {
  write(valid())
  expect(readBrowserDiagnostics(root, projectId, now)).toMatchObject({ informationalOnly: true, evidenceIsUntrusted: true, observations: [observation] })
  expect(readBrowserDiagnostics(root, '33333333-3333-4333-8333-333333333333', now)).toBeNull()
})
it.each([
  { message: 'password=never-show' }, { events: [{ ...observation, stack: 'secret' }] },
  { events: [{ ...observation, name: 'arbitrary secret value' }] }, { events: [{ ...observation, file: '../private.ts' }] },
  { updatedAt: now + 6000 }, { startedAt: now + 1 }, { events: Array.from({ length: 21 }, () => observation) },
])('ignores untrusted or invalid fields without blocking %j', extra => {
  write({ ...valid(), ...extra })
  expect(readBrowserDiagnostics(root, projectId, now)).toBeNull()
})
it('expires old observations, including when a heartbeat makes the artifact fresh', () => {
  write(valid())
  expect(readBrowserDiagnostics(root, projectId, now + 15 * 60 * 1000)).toBeNull()
  write({ ...valid(), updatedAt: now + 15 * 60 * 1000 })
  expect(readBrowserDiagnostics(root, projectId, now + 15 * 60 * 1000)).toBeNull()
  write({ ...valid(), events: [{ ...observation, firstSeenAt: now - 3000 }] })
  expect(readBrowserDiagnostics(root, projectId, now)).toBeNull()
})
it('limits summaries and reuses the existing diagnostic redactor for trusted source names', () => {
  write({ ...valid(), events: Array.from({ length: 12 }, () => ({ ...observation, file: 'src/sb_secret_nevershow.ts' })) })
  const result = readBrowserDiagnostics(root, projectId, now)
  expect(result!.observations).toHaveLength(8)
  expect(JSON.stringify(result)).not.toContain('nevershow')
})
it('ignores absent, oversized, symlinked and hardlinked artifacts', () => {
  expect(readBrowserDiagnostics(root, projectId, now)).toBeNull()
  fs.writeFileSync(path.join(root, BROWSER_DIAGNOSTICS_PATH), 'x'.repeat(16385))
  expect(readBrowserDiagnostics(root, projectId, now)).toBeNull()
  write(valid())
  fs.renameSync(path.join(root, BROWSER_DIAGNOSTICS_PATH), path.join(root, 'outside.json'))
  fs.symlinkSync(path.join(root, 'outside.json'), path.join(root, BROWSER_DIAGNOSTICS_PATH))
  expect(readBrowserDiagnostics(root, projectId, now)).toBeNull()
  fs.unlinkSync(path.join(root, BROWSER_DIAGNOSTICS_PATH))
  fs.linkSync(path.join(root, 'outside.json'), path.join(root, BROWSER_DIAGNOSTICS_PATH))
  expect(readBrowserDiagnostics(root, projectId, now)).toBeNull()
})
it('never changes authorization, next action, validation or stored turn state', () => {
  write(valid())
  const workspace = { projectId, environment: 'development' as const, headSha: 'a'.repeat(40), fingerprint: 'fixture', dirty: false }
  const output: TurnResult = { protocolVersion: 1, workerAvailable: true, allowed: false, reason: 'Acesso recusado.',
    state: { sessionId: 'session', hostPid: null, repairCheckpointId: null, summary: 'fixture', readOnly: true,
      turn: { version: 1, turnId: projectId, projectId, environment: 'development', phase: 'preflight', status: 'blocked',
        startedAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), workspace, recovery: null,
        acceptanceCriteria: [], validations: [], checkpointId: null, integrationMode: 'assisted' },
      context: { project: 'fixture', projectId, repository: null, currentRef: 'main', workspace, environment: 'development', databaseEnvironment: 'development', databaseAuthority: 'blocked',
        preview: { url: null, healthy: false }, daemon: { running: false }, latestCheckpoint: null, pendingRecovery: null, pendingValidation: [], securityState: 'unknown', integrationMode: 'assisted', reconciliation: { status: 'fresh', observedAt: new Date(now).toISOString() } } } }
  const before = JSON.stringify(output)
  const result = turnAgentResponse(output, root)
  expect(result.allowed).toBe(false)
  expect(result.nextAction).toBeUndefined()
  expect(result.context!.browserDiagnostics!.informationalOnly).toBe(true)
  expect(JSON.stringify(output)).toBe(before)
  expect(turnAgentResponse(output).context).not.toHaveProperty('browserDiagnostics')
})
