import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BackendTurnContext } from '../../../src/lib/checkpoint/turn-context'
import { defaultCheckpointDeps } from './checkpoint'
import { drainOnce } from './daemon'
import { runTurnEvent, type RuntimeDeps } from './turn-runtime'
import { drainLocalValidation, evidenceFor, validateCheckpoint } from './turn-validation'
import { captureTurnCheckpoint, gitText, readJson, TURN_DIR, writeJson } from './turn-workspace'

const PROJECT = '11111111-1111-4111-8111-111111111111'
const TURN = '22222222-2222-4222-8222-222222222222'
let cwd: string
let remote: BackendTurnContext
let deps: RuntimeDeps
const hook = { session_id: 'session', hook_event_name: 'UserPromptSubmit', prompt: 'Adicione busca.' }
const fixtureVerify = `import fs from 'node:fs'; import { execFileSync } from 'node:child_process';
const sha = execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
const base = process.argv[process.argv.indexOf('--base')+1];
fs.mkdirSync('.supremo',{recursive:true});
const report = { sha, base, status:'passed', checks:[{name:'unit',status:'passed'}] };
REWRITE
fs.writeFileSync('.supremo/verify-result.json',JSON.stringify(report));
if(report.status === 'failed') process.exit(1);
`
function verifier(rewrite = ''): void { fs.writeFileSync(path.join(cwd, 'scripts/verify.mjs'), fixtureVerify.replace('REWRITE', rewrite)) }
function change(): void { fs.writeFileSync(path.join(cwd, 'src/card.ts'), 'export const card = 2;\n') }
function capture() {
  const record = captureTurnCheckpoint(cwd, { projectId: PROJECT, turnId: TURN, summary: 'Busca', environment: 'development' })
  if (!record) throw new Error('Missing captured snapshot')
  return record
}
function failRemote(): void {
  const record = defaultCheckpointDeps(cwd).readQueue().at(-1)!
  remote.latestCheckpoint = { id: record.checkpointId, localSha: record.commitSha, publishedSha: 'f'.repeat(40),
    pushStatus: 'published', integrationStatus: 'blocked', integrationBranch: 'supremo/integration', createdAt: record.createdAt }
  remote.feedback = { current: { projectId: PROJECT, checkpointId: record.checkpointId, commitSha: record.commitSha,
    publishedSha: 'f'.repeat(40), observedAt: new Date().toISOString(), state: 'failed', failures: [{ name: 'unit', category: 'code' }],
    summary: 'Busca não encontra o chamado', evidence: 'Expected ticket, received []' }, previousFailure: null }
}
beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'supremo-lifecycle-regression-'))
  gitText(cwd, ['init', '-b', 'main']); gitText(cwd, ['config', 'user.name', 'Regression'])
  gitText(cwd, ['config', 'user.email', 'regression@example.invalid'])
  gitText(cwd, ['remote', 'add', 'origin', 'https://github.com/fixture/app.git'])
  fs.mkdirSync(path.join(cwd, 'scripts')); fs.mkdirSync(path.join(cwd, 'src')); fs.mkdirSync(path.join(cwd, 'tests'))
  fs.writeFileSync(path.join(cwd, '.gitignore'), '.supremo/turns/\n.supremo/validation/\n.supremo/checkpoints/\n.supremo/*context.json\n.supremo/*feedback.json\n.next/\n')
  fs.writeFileSync(path.join(cwd, 'src/card.ts'), 'export const card = 1;\n')
  fs.writeFileSync(path.join(cwd, 'tests/gate.test.ts'), 'export const gate = true;\n')
  writeJson(path.join(cwd, '.supremo/project.json'), { projectId: PROJECT, supremoUrl: 'https://supremo.example.invalid' })
  verifier(); gitText(cwd, ['add', '-A']); gitText(cwd, ['commit', '-m', 'fixture'])
  remote = { version: 1, projectId: PROJECT, project: { id: PROJECT, name: 'App' },
    repository: { fullName: 'fixture/app', url: 'https://github.com/fixture/app.git', branch: 'main', defaultBranch: 'main' },
    environment: 'development', databaseEnvironment: 'development', databaseAuthority: { automaticMigrations: true, projectRef: 'dev', source: 'supremo_provisioned' },
    latestCheckpoint: null, feedback: { current: null, previousFailure: null }, observedAt: new Date().toISOString() }
  deps = { now: () => new Date().toISOString(), reconcile: async () => remote,
    ensureServices: () => ({ daemon: { running: true }, preview: { healthy: true, url: 'http://localhost:3000' } }) }
})
afterEach(() => { vi.unstubAllGlobals(); fs.rmSync(cwd, { force: true, recursive: true }) })

describe('validation evidence is bound to the executed isolated snapshot', () => {
  it.each([
    ['empty checks', 'report.checks = []'],
    ['contradictory status', "report.checks[0].status = 'failed'"],
    ['wrong SHA', "report.sha = 'a'.repeat(40)"],
    ['wrong base', "report.base = 'a'.repeat(40)"],
    ['unknown check status', "report.checks[0].status = 'warning'"],
  ])('rejects %s even if the child process exits successfully', async (_name, rewrite) => {
    verifier(rewrite); change()
    expect((await validateCheckpoint(cwd, capture())).status).toBe('failed')
  })

  it('preserves structured failures after a nonzero exit, with sensitive logs sanitized', async () => {
    verifier("report.status='failed'; report.checks[0].status='failed'; console.error('token=topsecret');")
    const evidence = await validateCheckpoint(cwd, capture())
    expect(evidence).toMatchObject({ status: 'failed', checks: [{ name: 'unit', type: 'unit', status: 'failed' }] })
    expect(evidence.logs).not.toContain('topsecret')
  })

  it('uses only synthetic loopback public configuration and never inherits database credentials', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://production.example.invalid')
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'real-project-anon-key')
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'real-service-secret')
    verifier("if(process.env.NEXT_PUBLIC_SUPABASE_URL!=='http://127.0.0.1:9'||process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!=='supremo-synthetic-smoke-key'||process.env.SUPABASE_SERVICE_ROLE_KEY)throw new Error('Unsafe inherited environment');")
    try { expect((await validateCheckpoint(cwd, capture())).status).toBe('passed') }
    finally { vi.unstubAllEnvs() }
  })

  it('does not rewrite the live preview, index or HEAD, and rejects evidence relinked to another environment/base', async () => {
    verifier("fs.mkdirSync('.next',{recursive:true}); fs.writeFileSync('.next/marker','validation');")
    change(); fs.mkdirSync(path.join(cwd, '.next')); fs.writeFileSync(path.join(cwd, '.next/marker'), 'preview')
    const head = gitText(cwd, ['rev-parse', 'HEAD']); const index = fs.readFileSync(path.join(cwd, '.git/index'))
    const record = capture(); const proof = await validateCheckpoint(cwd, record)
    const validated = { ...record, validationId: proof.id }
    expect(proof.status).toBe('passed'); expect(evidenceFor(cwd, validated)?.sha).toBe(record.commitSha)
    expect(evidenceFor(cwd, { ...validated, environment: 'production' })).toBeNull()
    expect(evidenceFor(cwd, { ...validated, changesetBaseSha: record.commitSha })).toBeNull()
    expect(fs.readFileSync(path.join(cwd, '.next/marker'), 'utf8')).toBe('preview')
    expect(gitText(cwd, ['rev-parse', 'HEAD'])).toBe(head); expect(fs.readFileSync(path.join(cwd, '.git/index'))).toEqual(index)
  })

  it('revalidates the expanded diff before bypassing an unpublished failed checkpoint', async () => {
    const base = gitText(cwd, ['rev-parse', 'HEAD'])
    fs.mkdirSync(path.join(cwd, 'supabase/migrations'), { recursive: true })
    fs.writeFileSync(path.join(cwd, 'supabase/migrations/001.sql'), '-- fixture migration\n')
    const failed = capture()
    const queue = defaultCheckpointDeps(cwd)
    queue.appendQueue({ ...failed, validationStatus: 'failed' })
    change(); const latest = capture()
    expect(latest.riskLevel).toBe('low')
    await drainLocalValidation(cwd)
    const published: unknown[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit) => {
      if (url.endsWith('/restore-poll')) return Response.json({ requests: [] })
      published.push(JSON.parse(String(options.body)) as unknown)
      return Response.json({ prNumber: 1 })
    }))
    const config = { cwd, projectId: PROJECT, apiBaseUrl: 'https://supremo.example.invalid', getSecret: () => 'device-test' }
    expect(await drainOnce(config)).toBe(0)
    const expanded = queue.readQueue().at(-1)!
    expect(expanded).toMatchObject({ checkpointId: latest.checkpointId, validationStatus: 'pending', riskLevel: 'high',
      changesetBaseSha: base, migrations: ['supabase/migrations/001.sql'] })
    expect(evidenceFor(cwd, expanded)).toBeNull()
    expect(published).toEqual([])
    await drainLocalValidation(cwd)
    expect(await drainOnce(config)).toBe(1)
    expect(published).toEqual([expect.objectContaining({ riskLevel: 'high', migrations: ['supabase/migrations/001.sql'] })])
  })
})

describe('host mutations and recovery share an executable workspace lease', () => {
  it('does not consume a repair attempt while preview or worker readiness blocks mutation', async () => {
    await runTurnEvent('preflight', cwd, hook, 'codex', deps); change(); await runTurnEvent('complete', cwd); failRemote()
    const unavailable = { ...deps, ensureServices: () => { throw new Error('Worker starting') } }
    const blocked = await runTurnEvent('preflight', cwd, hook, 'codex', unavailable)
    expect(blocked.allowed).toBe(false); expect(blocked.state?.turn.recovery).toMatchObject({ status: 'pending', attempts: 0 })
    expect((await runTurnEvent('repair-start', cwd)).allowed).toBe(false)
    expect((await runTurnEvent('preflight', cwd, hook, 'codex', deps)).state?.turn.recovery).toMatchObject({ status: 'repairing', attempts: 1 })
  })

  it('waits for exact named RLS artifact evidence before resolving a deferred behavioral repair', async () => {
    writeJson(path.join(cwd, '.supremo/acceptance.json'), { version: 1,
      criteria: [{ id: 'owner-isolation', description: 'B cannot change A tickets', requiredChecks: ['owner isolation'] }],
      checks: [{ name: 'owner isolation', type: 'rls', files: ['tests/gate.test.ts'] }] })
    gitText(cwd, ['add', '-A']); gitText(cwd, ['commit', '-m', 'acceptance contract'])
    await runTurnEvent('preflight', cwd, hook, 'codex', deps); change(); await runTurnEvent('complete', cwd)
    failRemote(); remote.feedback.current!.failures = [{ name: 'RLS', category: 'security' }]
    await runTurnEvent('preflight', cwd, hook, 'codex', deps)
    fs.writeFileSync(path.join(cwd, 'src/card.ts'), 'export const card = 3;\n')
    await runTurnEvent('repair-complete', cwd)
    while (defaultCheckpointDeps(cwd).readQueue().some((record) => record.validationStatus === 'pending')) await drainLocalValidation(cwd)
    failRemote()
    const proof = { ...remote.feedback.current!, state: 'passed' as const, failures: [],
      checks: [{ name: 'Políticas RLS', status: 'passed' as const }, { name: 'Tipos, lint e auditoria', status: 'passed' as const }] }
    const feedbackFile = path.join(cwd, '.supremo/validation-feedback.json')
    writeJson(feedbackFile, { current: proof, previousFailure: null })
    expect((await runTurnEvent('status', cwd)).state?.turn.recovery?.status).toBe('repairing')
    const artifact = { version: 1, projectId: PROJECT, environment: 'development', sha: proof.publishedSha,
      completedAt: new Date().toISOString(), runId: 12, runAttempt: 1,
      checks: [{ name: 'owner isolation', type: 'rls', status: 'passed' }], criterionIds: [] }
    writeJson(feedbackFile, { current: { ...proof, acceptance: { ...artifact, sha: 'a'.repeat(40) } }, previousFailure: null })
    expect((await runTurnEvent('status', cwd)).state?.turn.recovery?.status).toBe('repairing')
    writeJson(feedbackFile, { current: { ...proof, acceptance: artifact }, previousFailure: null })
    const settled = await runTurnEvent('status', cwd)
    expect(settled.state?.turn.recovery).toMatchObject({ required: false, status: 'resolved', attempts: 1 })
    expect(settled.state?.repairCheckpointId).toBeNull()
  })

  it('exposes developing, validating and healthy from actual checkpoint receipts', async () => {
    expect((await runTurnEvent('preflight', cwd, hook, 'codex', deps)).projectHealth).toBe('developing')
    change(); expect((await runTurnEvent('complete', cwd)).projectHealth).toBe('validating')
    await drainLocalValidation(cwd)
    expect((await runTurnEvent('status', cwd)).projectHealth).toBe('validating')
    failRemote()
    remote.feedback.current = { ...remote.feedback.current!, state: 'passed', failures: [] }
    await runTurnEvent('preflight', cwd, hook, 'codex', deps)
    expect((await runTurnEvent('complete', cwd)).projectHealth).toBe('healthy')
    expect((await runTurnEvent('status', cwd)).state?.context.securityState).toBe('safe')
  })

  it('waits for an in-flight tool before checkpoint, draft validation or another preflight', async () => {
    await runTurnEvent('preflight', cwd, hook, 'codex', deps)
    await runTurnEvent('before-mutation', cwd, { tool_name: 'Write', tool_input: { file_path: 'src/card.ts' }, tool_use_id: 'edit' })
    change()
    const state = (await runTurnEvent('status', cwd)).state!
    writeJson(path.join(cwd, TURN_DIR, 'validation-request.json'), { turnId: state.turn.turnId, dueAt: 0 })
    expect((await runTurnEvent('complete', cwd)).allowed).toBe(false)
    expect(await drainLocalValidation(cwd)).toBe(0)
    await expect(runTurnEvent('preflight', cwd, hook, 'codex', deps)).rejects.toThrow('Ferramenta ainda ativa')
    expect(readJson(path.join(cwd, TURN_DIR, 'validation-request.json'))).toBeTruthy()
    await runTurnEvent('mutation', cwd, { tool_use_id: 'edit' })
    expect((await runTurnEvent('complete', cwd)).allowed).toBe(true)
  })

  it('allows Codex implementation patches during recovery and denies renames into gates or symlink aliases', async () => {
    fs.symlinkSync('../tests', path.join(cwd, 'src/alias'))
    await runTurnEvent('preflight', cwd, hook, 'codex', deps); change(); await runTurnEvent('complete', cwd); failRemote()
    const preflight = await runTurnEvent('preflight', cwd, hook, 'codex', deps)
    expect(preflight.state?.turn.integrationMode).toBe('enforced')
    expect(preflight.state?.turn.recovery?.status).toBe('repairing')
    const patch = (body: string) => runTurnEvent('before-mutation', cwd, { tool_name: 'apply_patch',
      tool_input: { command: `*** Begin Patch\n${body}\n*** End Patch` } })
    expect((await patch('*** Update File: src/card.ts\n@@\n-export const card = 2;\n+export const card = 3;')).allowed).toBe(true)
    expect((await patch('*** Update File: src/card.ts\n*** Move to: tests/gate.test.ts')).allowed).toBe(false)
    expect((await patch('*** Update File: src/alias/gate.test.ts\n@@\n-old\n+new')).allowed).toBe(false)
    expect((await runTurnEvent('before-mutation', cwd, { tool_name: 'Bash', tool_input: { command: 'supremo turn repair-complete' }, tool_use_id: 'lifecycle' })).allowed).toBe(true)
    expect((await runTurnEvent('before-mutation', cwd, { tool_name: 'Bash', tool_input: { command: "sed -n '1,120p' tests/gate.test.ts" }, tool_use_id: 'diagnostic' })).allowed).toBe(true)
    expect(readJson(path.join(cwd, TURN_DIR, 'mutation-lease.json'))).toBeNull()
  })

  it('blocks a repository impersonating the same owner/name on another server', async () => {
    gitText(cwd, ['remote', 'set-url', 'origin', 'https://untrusted.example/fixture/app.git'])
    const preflight = await runTurnEvent('preflight', cwd, hook, 'codex', deps)
    expect(preflight.allowed).toBe(false); expect(preflight.state?.context.reconciliation.status).toBe('invalid')
  })
})
