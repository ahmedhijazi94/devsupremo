import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { CODEX_HOOK_PATH, CODEX_SETTINGS_PATH, CLAUDE_SETTINGS_PATH, TURN_HOOK_PATH, codexHookSettings, claudeHookSettings, inspectHostAdapters, installHostAdapters, lifecycleCliCompatible, mergeClaudeSettings, turnHookScript } from './host-adapters'
import { validateLocalReadiness } from './bootstrap'

const dirs: string[] = []
function fixture(cli = 'console.log(JSON.stringify({protocolVersion:1,workerAvailable:true,allowed:true,context:{pendingRecovery:{required:true}}}))'): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'supremo-host-'))
  dirs.push(root)
  fs.mkdirSync(path.join(root, 'node_modules/supremo-cli/dist'), { recursive: true })
  fs.writeFileSync(path.join(root, 'node_modules/supremo-cli/dist/bin.js'), cli)
  return root
}
afterEach(() => { for (const root of dirs.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

describe('host installation and executable protocol', () => {
  it('instala idempotentemente e preserva permissões e hooks do usuário', () => {
    const root = fixture()
    fs.mkdirSync(path.join(root, '.claude'))
    fs.writeFileSync(path.join(root, '.claude/settings.json'), JSON.stringify({ permissions: { deny: ['Bash(rm:*)'] },
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo owned' }] }] } }))
    expect(installHostAdapters(root).adapters['claude-code'].verified).toBe(true)
    const before = fs.readFileSync(path.join(root, '.claude/settings.json'), 'utf8')
    installHostAdapters(root)
    expect(fs.readFileSync(path.join(root, '.claude/settings.json'), 'utf8')).toBe(before)
    expect(before).toContain('echo owned')
    expect(before).toContain('Bash(rm:*)')
    expect(inspectHostAdapters(root).adapters.codex.integrationMode).toBe('assisted')
  })
  it.each(['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop'])('ausência de %s nunca recebe enforced', (event) => {
    const root = fixture(); installHostAdapters(root)
    const settings = JSON.parse(claudeHookSettings()) as { hooks: Record<string, unknown> }
    delete settings.hooks[event]
    fs.writeFileSync(path.join(root, '.claude/settings.json'), JSON.stringify(settings))
    expect(inspectHostAdapters(root).adapters['claude-code'].integrationMode).toBe('unsupported')
  })
  it('CLI antiga ou quebrada impede bootstrap pronto', () => {
    expect(() => installHostAdapters(fixture('console.log("legacy")'))).toThrow('não está pronto')
    expect(lifecycleCliCompatible('{"allowed":true}')).toBe(false)
  })
  it('configuração inválida não é sobrescrita com falso sucesso', () => {
    const root = fixture(); fs.mkdirSync(path.join(root, '.claude'))
    fs.writeFileSync(path.join(root, '.claude/settings.json'), 'invalid')
    expect(() => installHostAdapters(root)).toThrow('crítica')
    expect(fs.readFileSync(path.join(root, '.claude/settings.json'), 'utf8')).toBe('invalid')
  })
  it.each([null, [], { disableAllHooks: true }, { hooks: [] }])('rejeita settings inválido/desativado %#', (settings) => {
    expect(() => mergeClaudeSettings(settings)).toThrow()
  })
  it('wrapper injeta contexto do preflight e recusa outro projeto', () => {
    const root = fixture(); installHostAdapters(root)
    const call = (cwd: string) => spawnSync(process.execPath, [path.join(root, 'scripts/supremo-turn-hook.mjs'), 'preflight'], {
      input: JSON.stringify({ cwd, session_id: 'new', hook_event_name: 'UserPromptSubmit', prompt: 'Adicione busca.' }), encoding: 'utf8' })
    const result = call(root)
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout).hookSpecificOutput.additionalContext).toContain('pendingRecovery')
    expect(call(os.tmpdir()).status).toBe(2)
  })
  it('Stop bloqueia conclusão pendente, sem aprovar permissões de ferramenta', () => {
    const root = fixture('console.log(JSON.stringify({protocolVersion:1,workerAvailable:true,allowed:false,reason:"repair_required"}))')
    fs.mkdirSync(path.join(root, 'scripts'))
    fs.mkdirSync(path.join(root, '.claude'))
    fs.writeFileSync(path.join(root, CLAUDE_SETTINGS_PATH), claudeHookSettings())
    fs.writeFileSync(path.join(root, 'scripts/hook.mjs'), turnHookScript())
    const result = spawnSync(process.execPath, [path.join(root, 'scripts/hook.mjs'), 'complete'], {
      input: JSON.stringify({ cwd: root, session_id: 'new', hook_event_name: 'Stop' }), encoding: 'utf8' })
    expect(JSON.parse(result.stdout)).toEqual({ decision: 'block', reason: 'repair_required' })
  })
})

const ready = { projectJsonOk: true, hasDaemonIdentity: true, daemonRunning: true, npmScriptsCompatible: true,
  previewHealthy: true, setupSucceeded: true, gitHooksVerified: true, lifecycleVerified: true,
  validationWorkerAvailable: true, databaseEnvironmentReady: true, integrationMode: 'enforced' as const }
describe('readiness never greenwashes incomplete installation', () => {
  it.each(['setupSucceeded', 'gitHooksVerified', 'lifecycleVerified', 'validationWorkerAvailable', 'databaseEnvironmentReady'] as const)('%s é obrigatório', (component) => {
    expect(validateLocalReadiness({ ...ready, [component]: false }).state).toBe('not_ready')
  })
  it('host assisted fica degraded mesmo com serviços saudáveis', () => {
    expect(validateLocalReadiness({ ...ready, integrationMode: 'assisted' }).state).toBe('degraded')
  })
})


type HookSettings = { hooks: Record<string, { hooks: Record<string, unknown>[] }[]> }
const coreEvents = { UserPromptSubmit: 'preflight', PreToolUse: 'before-mutation', PostToolUse: 'mutation', Stop: 'complete' }
function dispatch(root: string, host: 'claude-code' | 'codex', event: keyof typeof coreEvents, session = 'session-one') {
  return spawnSync(process.execPath, [path.join(root, host === 'codex' ? CODEX_HOOK_PATH : TURN_HOOK_PATH), coreEvents[event]], {
    input: JSON.stringify({ cwd: root, session_id: session, hook_event_name: event, tool_name: 'Bash', tool_input: { command: 'echo fixture' } }), encoding: 'utf8',
  })
}

describe('Codex native lifecycle and executable receipts', () => {
  it.each(['claude-code', 'codex'] as const)('%s only upgrades after all events execute for the installed configuration', (host) => {
    const root = fixture()
    const initial = installHostAdapters(root).adapters[host]
    expect(initial).toMatchObject({ installed: true, verified: true, runtimeVerified: false, integrationMode: 'assisted' })
    for (const event of Object.keys(coreEvents) as (keyof typeof coreEvents)[]) {
      expect(inspectHostAdapters(root).adapters[host].integrationMode).toBe('assisted')
      const response = dispatch(root, host, event)
      expect(response.status, response.stderr).toBe(0)
    }
    expect(inspectHostAdapters(root).adapters[host]).toMatchObject({ runtimeVerified: true, integrationMode: 'enforced' })
    // A new host session must deliver a full cycle itself; old receipts cannot approve it.
    expect(dispatch(root, host, 'UserPromptSubmit', 'new-session').status).toBe(0)
    expect(inspectHostAdapters(root).adapters[host].integrationMode).toBe('assisted')
  })
  it('configuration changes invalidate runtime receipts without changing user trust', () => {
    const root = fixture(); installHostAdapters(root)
    for (const event of Object.keys(coreEvents) as (keyof typeof coreEvents)[]) dispatch(root, 'codex', event)
    const config = path.join(root, CODEX_SETTINGS_PATH)
    const settings = JSON.parse(fs.readFileSync(config, 'utf8')) as HookSettings & { description?: string }
    settings.description = 'User edited configuration'
    fs.writeFileSync(config, JSON.stringify(settings))
    expect(inspectHostAdapters(root).adapters.codex).toMatchObject({ verified: true, runtimeVerified: false, integrationMode: 'assisted' })
  })
  it.each(['claude-code', 'codex'] as const)('%s emits native denials and never grants host permissions', (host) => {
    const root = fixture(); installHostAdapters(root)
    fs.writeFileSync(path.join(root, 'node_modules/supremo-cli/dist/bin.js'), 'console.log(JSON.stringify({allowed:false,reason:"pending recovery"}))')
    const result = dispatch(root, host, 'PreToolUse')
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'pending recovery' } })
  })
  it.each([{ async: true }, { asyncRewake: true }, { if: 'Bash(git *)' }, { timeout: 1 }, { commandWindows: 'echo bypass' }])('refuses a conditionally disabled or asynchronous gate %#', (override) => {
    const root = fixture(); installHostAdapters(root)
    const settings = JSON.parse(codexHookSettings()) as HookSettings
    Object.assign(settings.hooks.PreToolUse![0]!.hooks[0]!, override)
    fs.writeFileSync(path.join(root, CODEX_SETTINGS_PATH), JSON.stringify(settings))
    expect(inspectHostAdapters(root).adapters.codex.integrationMode).toBe('unsupported')
  })
  it('preserves Codex hooks, does not change trust, and rejects malformed Codex config before modifying Claude settings', () => {
    const root = fixture(); installHostAdapters(root)
    const before = fs.readFileSync(path.join(root, CLAUDE_SETTINGS_PATH), 'utf8')
    fs.writeFileSync(path.join(root, CODEX_SETTINGS_PATH), 'invalid user content')
    expect(() => installHostAdapters(root)).toThrow('crítica')
    expect(fs.readFileSync(path.join(root, CLAUDE_SETTINGS_PATH), 'utf8')).toBe(before)
    expect(fs.readFileSync(path.join(root, CODEX_SETTINGS_PATH), 'utf8')).toBe('invalid user content')
  })
  it('fails closed without echoing child credentials or accepting another event', () => {
    const root = fixture(); installHostAdapters(root)
    fs.writeFileSync(path.join(root, 'node_modules/supremo-cli/dist/bin.js'), 'console.error("sensitive-child-output"); process.exit(1)')
    const failure = dispatch(root, 'codex', 'UserPromptSubmit')
    expect(failure.status).toBe(2)
    expect(failure.stdout + failure.stderr).not.toContain('sensitive-child-output')
    const mismatch = spawnSync(process.execPath, [path.join(root, CODEX_HOOK_PATH), 'complete'], {
      input: JSON.stringify({ cwd: root, session_id: 'one', hook_event_name: 'UserPromptSubmit' }), encoding: 'utf8',
    })
    expect(mismatch.status).toBe(2)
  })
})

describe('host activation failures remain explicit', () => {
  it.each(['[features]\nhooks = false\n', 'features.codex_hooks = false\n', 'allow_managed_hooks_only = true\n'])('disabled Codex project hooks never count as installed automation', (config) => {
    const root = fixture(); installHostAdapters(root)
    fs.writeFileSync(path.join(root, '.codex/config.toml'), config)
    expect(inspectHostAdapters(root).adapters.codex).toMatchObject({ integrationMode: 'unsupported', verified: false, runtimeVerified: false })
  })
  it('a missing Codex wrapper fails inspection instead of borrowing Claude capability', () => {
    const root = fixture(); installHostAdapters(root)
    fs.unlinkSync(path.join(root, CODEX_HOOK_PATH))
    const status = inspectHostAdapters(root)
    expect(status.adapters.codex.verified).toBe(false)
    expect(status.adapters['claude-code'].verified).toBe(true)
  })
})
