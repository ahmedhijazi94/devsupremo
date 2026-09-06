import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BackendTurnContext } from '../../../src/lib/checkpoint/turn-context'
import { defaultCheckpointDeps } from './checkpoint'
import { runTurnEvent, type RuntimeDeps } from './turn-runtime'
import { drainLocalValidation, evidenceFor } from './turn-validation'
import { captureTree, gitText, readJson, writeJson } from './turn-workspace'

const PROJECT = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const PROMPTS = [
  'Crie uma Central de Chamados para uma pequena equipe. Quero login e que cada usuário veja apenas os próprios chamados. Cada chamado deve ter título, descrição, prioridade e status. Quero criar, editar e excluir. Faça uma interface bonita e responsiva.',
  'Adicione busca por título, filtro por status, contadores e paginação. Melhore também a experiência no celular.',
  'Mostre a data e a hora de criação em cada chamado.',
]
let root: string
let backend: BackendTurnContext
let deps: RuntimeDeps
const input = (prompt = PROMPTS[0], session = 'one') => ({ prompt, session_id: session, hook_event_name: 'UserPromptSubmit' })
const source = (value: string): void => fs.writeFileSync(path.join(root, 'tickets.js'), value)
const queue = () => defaultCheckpointDeps(root).readQueue()
const fixtureVerify = `import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const failed = fs.readFileSync('tickets.js','utf8').includes('BROKEN');
fs.mkdirSync('.supremo',{recursive:true});
const sha = execFileSync('git', ['rev-parse', 'HEAD'], {encoding:'utf8'}).trim();
const base = process.argv[process.argv.indexOf('--base') + 1];
fs.writeFileSync('.supremo/verify-result.json',JSON.stringify({sha, base, status:failed?'failed':'passed', checks:[{name:'unit',status:failed?'failed':'passed'}]}));
if(failed){console.error('verify quick falhou em: unit');process.exit(1)}
`

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'supremo-turn-e2e-'))
  gitText(root, ['init', '-b', 'main'])
  gitText(root, ['config', 'user.name', 'Supremo Harness'])
  gitText(root, ['config', 'user.email', 'harness@example.invalid'])
  gitText(root, ['remote', 'add', 'origin', 'https://github.com/fixture/tickets.git'])
  fs.mkdirSync(path.join(root, '.supremo'))
  fs.mkdirSync(path.join(root, 'scripts'))
  fs.writeFileSync(path.join(root, '.gitignore'), '.supremo/turns/\n.supremo/validation/\n.supremo/checkpoints/\n.supremo/turn-context.json\n.supremo/validation-feedback.json\n')
  writeJson(path.join(root, '.supremo/project.json'), { projectId: PROJECT, supremoUrl: 'https://supremo.example.invalid' })
  fs.writeFileSync(path.join(root, 'scripts/verify.mjs'), fixtureVerify)
  source('export const tickets = [];\n')
  gitText(root, ['add', '-A']); gitText(root, ['commit', '-m', 'fixture'])
  backend = { version: 1, projectId: PROJECT, project: { id: PROJECT, name: 'Central de Chamados' },
    repository: { fullName: 'fixture/tickets', url: 'https://github.com/fixture/tickets.git', branch: 'main', defaultBranch: 'main' },
    environment: 'development', databaseEnvironment: 'development',
    databaseAuthority: { projectRef: 'test-ref', source: 'supremo_provisioned', automaticMigrations: true },
    latestCheckpoint: null, feedback: { current: null, previousFailure: null }, observedAt: new Date().toISOString() }
  deps = { reconcile: async () => backend, now: () => new Date().toISOString(),
    ensureServices: () => ({ preview: { healthy: true, url: 'http://localhost:3000' }, daemon: { running: true } }) }
})
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

function remoteFailure(): void {
  const record = queue().at(-1)!
  const remoteSha = 'b'.repeat(40)
  backend.latestCheckpoint = { id: record.checkpointId, localSha: record.commitSha, publishedSha: remoteSha,
    pushStatus: 'published', integrationStatus: 'blocked', integrationBranch: 'supremo/integration', createdAt: record.createdAt }
  backend.feedback = { current: { projectId: PROJECT, checkpointId: record.checkpointId, commitSha: record.commitSha,
    publishedSha: remoteSha, observedAt: new Date().toISOString(), state: 'failed',
    failures: [{ name: 'unit', category: 'code' }], summary: 'Falha controlada de unidade', evidence: 'unit regression' }, previousFailure: null }
}

describe('lifecycle executable integration — real Git/worktrees, deterministic host/backend', () => {
  it('prompts de produto → checkpoints → falha remota → cold start → reparo comprovado → feature', async () => {
    const initialHead = gitText(root, ['rev-parse', 'HEAD'])
    const initialIndex = fs.readFileSync(path.join(root, '.git/index'))
    for (let turn = 0; turn < 2; turn++) {
      const preflight = await runTurnEvent('preflight', root, input(PROMPTS[turn]), 'claude-code', deps)
      expect(preflight.allowed).toBe(true)
      source(`export const tickets = ['turn ${turn + 1}'];\n`)
      expect((await runTurnEvent('complete', root, { session_id: 'one' })).allowed).toBe(true)
    }
    expect(queue()).toHaveLength(2)
    expect(queue().every((record) => record.validationStatus === 'pending')).toBe(true)
    expect(gitText(root, ['rev-parse', 'HEAD'])).toBe(initialHead)
    expect(fs.readFileSync(path.join(root, '.git/index'))).toEqual(initialIndex)
    remoteFailure()
    // Stale local file is intentionally clean. New process must read backend state.
    writeJson(path.join(root, '.supremo/validation-feedback.json'), { current: null, previousFailure: null })
    const third = await runTurnEvent('preflight', root, input(PROMPTS[2], 'new-conversation'), 'claude-code', deps)
    expect(third.allowed).toBe(true)
    expect(third.state?.turn.phase).toBe('recovery')
    expect(third.state?.turn.recovery?.attempts).toBe(1)
    expect((await runTurnEvent('complete', root, { session_id: 'new-conversation' })).allowed).toBe(false)
    source("export const tickets = ['fixed'];\n")
    const repair = await runTurnEvent('repair-complete', root)
    expect(repair.state?.repairCheckpointId).toBeTruthy()
    while (queue().some((record) => record.validationStatus === 'pending')) await drainLocalValidation(root)
    const guard = await runTurnEvent('before-mutation', root, { tool_name: 'Write', tool_input: { file_path: 'tickets.js' } })
    expect(guard.allowed).toBe(true)
    expect(guard.state?.turn.recovery?.status).toBe('resolved')
    source("export const tickets = [{createdAt: '2026-09-06T12:00:00Z'}];\n")
    expect((await runTurnEvent('complete', root)).allowed).toBe(true)
    await drainLocalValidation(root)
    const last = queue().at(-1)!
    expect(evidenceFor(root, last)?.sha).toBe(last.commitSha)
    expect(gitText(root, ['rev-parse', 'HEAD'])).toBe(initialHead)
    // A fresh OS process reads persisted state; no conversation memory is involved.
    const cli = path.resolve(__dirname, '../dist/bin.js')
    const cold = JSON.parse(execFileSync(process.execPath, [cli, 'turn', 'status'], { cwd: root, encoding: 'utf8', input: '' })) as { state: { turn: { recovery: { status: string } } } }
    expect(cold.state.turn.recovery.status).toBe('resolved')
  }, 30_000)

  it('reconciliação offline preserva recovery e não deixa editar; nova consulta recupera', async () => {
    await runTurnEvent('preflight', root, input(), 'claude-code', deps)
    source('export const ticket = 1;'); await runTurnEvent('complete', root)
    remoteFailure()
    await runTurnEvent('preflight', root, input(), 'claude-code', deps)
    const offline = { ...deps, reconcile: async (): Promise<BackendTurnContext> => { throw new Error('offline') } }
    const blocked = await runTurnEvent('preflight', root, input(), 'claude-code', offline)
    expect(blocked.allowed).toBe(false)
    expect(blocked.state?.turn.recovery?.required).toBe(true)
    expect(blocked.state?.context.reconciliation.status).toBe('offline')
    expect((await runTurnEvent('preflight', root, input(), 'claude-code', deps)).state?.context.reconciliation.status).toBe('fresh')
  })

  it('feedback stale não inicia reparo sobre arquivos novos', async () => {
    await runTurnEvent('preflight', root, input(), 'claude-code', deps)
    source('export const ticket = 1;'); await runTurnEvent('complete', root); remoteFailure()
    source('export const ticket = 2;')
    const stale = await runTurnEvent('preflight', root, input(), 'claude-code', deps)
    expect(stale.allowed).toBe(false)
    expect(stale.state?.turn.recovery?.status).toBe('stale')
  })

  it('dois hosts não podem editar simultaneamente e eventos de outra sessão são recusados', async () => {
    await runTurnEvent('preflight', root, { ...input(), supremo_host_pid: process.pid }, 'claude-code', deps)
    await expect(runTurnEvent('preflight', root, input('outro pedido', 'two'), 'claude-code', deps)).rejects.toThrow('Outro turno')
    expect((await runTurnEvent('mutation', root, { session_id: 'two' })).allowed).toBe(false)
  })

  it('identidade remota de outro projeto bloqueia preflight', async () => {
    backend = { ...backend, projectId: OTHER, project: { id: OTHER, name: 'Other' } }
    expect((await runTurnEvent('preflight', root, input(), 'claude-code', deps)).allowed).toBe(false)
  })

  it('falha local real conserva evidência e não aprova o snapshot', async () => {
    await runTurnEvent('preflight', root, input(), 'claude-code', deps)
    source('BROKEN'); await runTurnEvent('complete', root)
    await drainLocalValidation(root)
    const record = queue()[0]!
    expect(record.validationStatus).toBe('failed')
    expect(evidenceFor(root, record)?.logs).toContain('unit')
    expect((await runTurnEvent('preflight', root, input(), 'claude-code', deps)).state?.turn.recovery?.required).toBe(true)
  })

  it('sucesso sem report estruturado falha fechado', async () => {
    fs.writeFileSync(path.join(root, 'scripts/verify.mjs'), 'process.exit(0)')
    await runTurnEvent('preflight', root, input(), 'claude-code', deps)
    await runTurnEvent('complete', root); await drainLocalValidation(root)
    expect(queue()[0]?.validationStatus).toBe('failed')
  })

  it('recovery bloqueia edições nos testes, shell e saída via symlink', async () => {
    await runTurnEvent('preflight', root, input(), 'claude-code', deps)
    source('export const ticket = 1;'); await runTurnEvent('complete', root); remoteFailure()
    await runTurnEvent('preflight', root, input(), 'claude-code', deps)
    for (const file of ['tests/ownership.test.ts', '.github/workflows/ci.yml', 'supabase/migrations/001.sql']) {
      expect((await runTurnEvent('before-mutation', root, { tool_name: 'Write', tool_input: { file_path: file } })).allowed).toBe(false)
    }
    expect((await runTurnEvent('before-mutation', root, { tool_name: 'Bash', tool_input: { command: 'rm -rf tests' } })).allowed).toBe(false)
    expect(captureTree(root).treeSha).toBe(queue()[0]?.treeSha)
  })

  it('postflight é idempotente e exige preflight', async () => {
    expect((await runTurnEvent('complete', root)).allowed).toBe(false)
    await runTurnEvent('preflight', root, input(), 'claude-code', deps)
    source('export const ticket = 1;')
    await runTurnEvent('complete', root); await runTurnEvent('complete', root)
    expect(queue()).toHaveLength(1)
    expect(readJson(path.join(root, '.supremo/turns/state.json'))).toBeTruthy()
  })
  it('tentativas fracassadas persistem o orçamento através de novos processos/turnos', async () => {
    await runTurnEvent('preflight', root, input(), 'claude-code', deps)
    source('export const ticket = 1;'); await runTurnEvent('complete', root); remoteFailure()
    for (let attempt = 1; attempt <= 3; attempt++) {
      const start = await runTurnEvent('preflight', root, input(), 'claude-code', deps)
      expect(start.state?.turn.recovery?.attempts).toBe(attempt)
      source(`BROKEN ${attempt}`)
      await runTurnEvent('repair-complete', root)
      while (queue().some((record) => record.validationStatus === 'pending')) await drainLocalValidation(root)
      const state = await runTurnEvent('status', root)
      expect(state.state?.turn.recovery?.status).toBe(attempt === 3 ? 'needs_human_attention' : 'pending')
    }
    const final = await runTurnEvent('preflight', root, input(), 'claude-code', deps)
    expect(final.allowed).toBe(false)
    expect(final.state?.turn.recovery?.attempts).toBe(3)
  }, 30_000)

  it('valida saves com debounce sem publicar checkpoint nem alterar HEAD', async () => {
    await runTurnEvent('preflight', root, input(), 'claude-code', deps)
    source('export const ticket = 42;')
    await runTurnEvent('mutation', root)
    expect(await drainLocalValidation(root)).toBe(0)
    const request = readJson(path.join(root, '.supremo/turns/validation-request.json')) as { turnId: string }
    writeJson(path.join(root, '.supremo/turns/validation-request.json'), { ...request, dueAt: 0 })
    expect(await drainLocalValidation(root)).toBe(1)
    expect(queue()).toHaveLength(0)
    expect(readJson(path.join(root, '.supremo/validation/draft.json'))).toMatchObject({ validationStatus: 'passed' })
  })

  it('ferramentas paralelas recebem exclusão mútua e liberam ao terminar', async () => {
    await runTurnEvent('preflight', root, input(), 'claude-code', deps)
    const tool = { tool_name: 'Write', tool_input: { file_path: 'tickets.js' } }
    expect((await runTurnEvent('before-mutation', root, { ...tool, tool_use_id: 'a' })).allowed).toBe(true)
    expect((await runTurnEvent('before-mutation', root, { ...tool, tool_use_id: 'b' })).allowed).toBe(false)
    await runTurnEvent('mutation', root, { tool_use_id: 'a' })
    expect((await runTurnEvent('before-mutation', root, { ...tool, tool_use_id: 'b' })).allowed).toBe(true)
  })

})
