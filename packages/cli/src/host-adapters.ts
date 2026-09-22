import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { onboardingHookParserSource } from './onboarding-hook'

/** Protocol support means hooks are installed; execution receipts remain turn state. */
export type IntegrationMode = 'enforced' | 'assisted' | 'unsupported'
export interface HostAdapterStatus {
  host: 'claude-code' | 'codex'
  integrationMode: IntegrationMode
  installed: boolean
  verified: boolean
  runtimeVerified: boolean
  issues: string[]
}
export interface HostAdaptersStatus {
  schemaVersion: 1
  adapters: { 'claude-code': HostAdapterStatus; codex: HostAdapterStatus }
}

export const HOST_ADAPTER_STATE_PATH = '.supremo/host-adapters.json'
export const TURN_HOOK_PATH = 'scripts/supremo-turn-hook.mjs'
export const CLAUDE_SETTINGS_PATH = '.claude/settings.json'
export const CODEX_SETTINGS_PATH = '.codex/hooks.json'
export const CODEX_HOOK_PATH = 'scripts/supremo-codex-hook.mjs'
export type SupportedHost = 'claude-code' | 'codex'
const EVENTS = {
  UserPromptSubmit: 'preflight',
  PreToolUse: 'before-mutation',
  PostToolUse: 'mutation',
  PostToolUseFailure: 'mutation',
  Stop: 'complete',
} as const

type JsonObject = Record<string, unknown>
function object(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function legacyClaudeCommand(event: string): string {
  return `node "\${CLAUDE_PROJECT_DIR}/${TURN_HOOK_PATH}" ${event}`
}
function codexHookCommand(event: string): string {
  // exec replaces the temporary shell so process.ppid identifies the host.
  return `exec node "$(git rev-parse --show-toplevel)/${CODEX_HOOK_PATH}" ${event}`
}
function eventsFor(host: SupportedHost): Record<string, string> {
  return host === 'claude-code' ? EVENTS : {
    UserPromptSubmit: 'preflight', PreToolUse: 'before-mutation', PostToolUse: 'mutation', Stop: 'complete',
  }
}
function managedHook(host: SupportedHost, event: string): JsonObject {
  return host === 'claude-code'
    ? { type: 'command', command: 'node', args: [`\${CLAUDE_PROJECT_DIR}/${TURN_HOOK_PATH}`, event], timeout: 90 }
    : { type: 'command', command: codexHookCommand(event), timeout: 90 }
}
function isManagedHook(hook: unknown, host: SupportedHost, event: string): boolean {
  if (!object(hook)) return false
  const expected = managedHook(host, event)
  return hook.command === expected.command && JSON.stringify(hook.args) === JSON.stringify(expected.args)
}


/** Preserve user permissions and hooks. Replace only the exact managed command. */
function mergeSettings(existing: unknown, host: SupportedHost): JsonObject {
  if (!object(existing)) throw new Error('Claude settings deve ser um objeto JSON.')
  if (existing.disableAllHooks === true) throw new Error('Claude disableAllHooks está ativo; lifecycle não pode ser imposto.')
  if (existing.hooks !== undefined && !object(existing.hooks)) throw new Error('Claude hooks inválidos.')
  const hooks: JsonObject = { ...(object(existing.hooks) ? existing.hooks : {}) }
  const events = eventsFor(host)
  const managedCommands = new Set(Object.values(EVENTS).map(legacyClaudeCommand))
  for (const [eventName, event] of Object.entries(events)) {
    const prior = hooks[eventName]
    if (prior !== undefined && !Array.isArray(prior)) throw new Error(`Claude ${eventName} inválido.`)
    const groups: unknown[] = []
    for (const group of (prior ?? []) as unknown[]) {
      if (!object(group) || !Array.isArray(group.hooks)) throw new Error(`Claude ${eventName} possui grupo inválido.`)
      const remaining: unknown[] = group.hooks.filter((hook: unknown) =>
        !(Object.values(events).some((managed) => isManagedHook(hook, host, managed)) ||
          (host === 'claude-code' && object(hook) && typeof hook.command === 'string' && managedCommands.has(hook.command))),
      )
      if (remaining.length) groups.push({ ...group, hooks: remaining })
    }
    // No tool-name allowlist: Bash/MCP/custom tools can also mutate files.
    groups.push({ hooks: [managedHook(host, event)] })
    hooks[eventName] = groups
  }
  return { ...existing, hooks }
}

export function mergeClaudeSettings(existing: unknown): JsonObject { return mergeSettings(existing, 'claude-code') }
export function mergeCodexSettings(existing: unknown): JsonObject { return mergeSettings(existing, 'codex') }
export function codexHookSettings(): string { return JSON.stringify(mergeCodexSettings({}), null, 2) + '\n' }

export function claudeHookSettings(): string {
  return JSON.stringify(mergeClaudeSettings({}), null, 2) + '\n'
}

/**
 * Host protocols: https://code.claude.com/docs/en/hooks
 * https://developers.openai.com/codex/hooks
 * stdout JSON only, exit 0 for decisions; infrastructure errors use exit 2.
 * Never allow/approve a tool here: omitting a decision preserves host permissions.
 */
export function turnHookScript(host: SupportedHost = 'claude-code'): string {
  return `#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
const host = ${JSON.stringify(host)}
const events = ${JSON.stringify(eventsFor(host))}
const event = process.argv[2]
const fail = (reason) => { console.error(reason); process.exit(2) }
${onboardingHookParserSource()}
try {
  const root = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'))
  if (!Object.values(events).includes(event)) fail('Supremo: evento de lifecycle desconhecido.')
  const input = fs.readFileSync(0, 'utf8')
  if (Buffer.byteLength(input) > 1048576) fail('Supremo: entrada de hook excede limite.')
  const payload = JSON.parse(input)
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
      typeof payload.session_id !== 'string' || !payload.session_id ||
      events[payload.hook_event_name] !== event) fail('Supremo: payload de hook inválido.')
  // The script location binds the project, not an arbitrary cwd supplied in JSON.
  if (typeof payload.cwd !== 'string') fail('Supremo: cwd do hook ausente.')
  const relative = path.relative(root, fs.realpathSync(path.resolve(payload.cwd)))
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) fail('Supremo: hook pertence a outro workspace.')
  let project = null
  try { project = JSON.parse(fs.readFileSync(path.join(root, '.supremo/project.json'), 'utf8')) } catch { /* lifecycle validates identity below */ }
  // This receipt only remembers the initial conversation. It grants no device,
  // server, feature or host authority, and never replaces a core lifecycle call.
  const canonicalIssuer = (value) => {
    if (typeof value !== 'string') return null
    try {
      const url = new URL(value)
      if (url.username || url.password || url.search || url.hash ||
          (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) return null
      return url.origin + url.pathname.replace(/\\/+$/, '')
    } catch { return null }
  }
  const projectIssuer = canonicalIssuer(project?.supremoUrl)
  const hasProject = project && typeof project.projectId === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(project.projectId) && projectIssuer !== null
  let rememberedOnboarding = false
  if (hasProject) {
    try {
      const directory = fs.lstatSync(path.join(root, '.supremo'))
      const filename = path.join(root, '.supremo/onboarding.json')
      const stat = fs.lstatSync(filename)
      if (directory.isDirectory() && !directory.isSymbolicLink() && stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= 16384) {
        const receipt = JSON.parse(fs.readFileSync(filename, 'utf8'))
        const keys = ['version', 'projectId', 'issuer', 'acceptedAt', 'scope']
        rememberedOnboarding = receipt && typeof receipt === 'object' && !Array.isArray(receipt) &&
          Object.keys(receipt).length === keys.length && keys.every(key => Object.hasOwn(receipt, key)) &&
          receipt.version === 1 && receipt.projectId === project.projectId && receipt.scope === 'project-development' &&
          canonicalIssuer(receipt.issuer) === projectIssuer && typeof receipt.acceptedAt === 'string' &&
          /^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z$/.test(receipt.acceptedAt) && Number.isFinite(Date.parse(receipt.acceptedAt))
      }
    } catch { /* Missing or malformed context means the initial question is still needed. */ }
  }
  if (hasProject && !rememberedOnboarding && (event === 'preflight' || event === 'complete')) {
    // Do not start services before the first question, even when a device was
    // authorized by bootstrap. Reporting/asking is not successful feature work.
    console.log(event === 'preflight' ? JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext:
      'Supremo: conversa inicial pendente. Siga a seção Primeiro pedido de desenvolvimento em AGENTS.md: reúna autorização e dúvidas do produto numa pergunta e aguarde a resposta antes de preparar ou alterar o app. Reutilize uma autorização explícita já dada nesta conversa para este projeto e endereço. Endereço deste projeto: ' + projectIssuer + '. Pedidos só de leitura não iniciam preparação. O registro local é apenas contexto; a preparação e o preflight do servidor continuam obrigatórios antes das funcionalidades.' } }) : '{}')
    process.exit(0)
  }
  const preparing = isOnboardingPrepare(payload, project, host, root)
  const asking = ['AskUserQuestion', 'request_user_input', 'request_user_input_async',
    'functions.request_user_input', 'functions.request_user_input_async'].includes(payload.tool_name)
  // Setup is a distinct operation with its own device/server checks. An empty
  // decision leaves the host's normal approval in place; it never approves it.
  if (preparing && event === 'before-mutation') { console.log('{}'); process.exit(0) }
  if (asking && (event === 'before-mutation' || event === 'mutation')) { console.log('{}'); process.exit(0) }
  const cli = path.join(root, 'node_modules/supremo-cli/dist/bin.js')
  if (!fs.existsSync(cli)) {
    if (['Read', 'Glob', 'Grep', 'LS'].includes(payload.tool_name) &&
        (event === 'before-mutation' || event === 'mutation')) { console.log('{}'); process.exit(0) }
    if (event === 'preflight') {
      console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext:
        'Supremo: preparação inicial pendente. Siga a seção Primeiro pedido de desenvolvimento em AGENTS.md: reúna autorização e dúvidas do produto numa pergunta, aguarde a resposta e use a CLI incluída para prepare. Pedidos só de leitura não iniciam preparação. Não altere funcionalidades antes do preflight autorizado.' } }))
      process.exit(0)
    }
    // Asking for authorization or reporting a failed setup is not a feature
    // completion. No receipt/checkpoint is produced while the CLI is absent.
    if (event === 'complete' || (preparing && event === 'mutation')) { console.log('{}'); process.exit(0) }
    fail('Supremo: preparação pendente; somente o fluxo oficial prepare pode prosseguir.')
  }
  const effectiveEvent = preparing && event === 'mutation' ? 'preflight' : event
  const result = spawnSync(process.execPath, [cli, 'turn', effectiveEvent, '--host', host], {
    cwd: root, input: JSON.stringify({ ...payload, cwd: root, supremo_host_pid: process.ppid }), encoding: 'utf8', timeout: 80000, killSignal: 'SIGKILL', maxBuffer: 2097152,
  })
  // Do not echo child stderr, argv, prompts or tool inputs: these may contain secrets.
  if (result.error || result.status !== 0) fail('Supremo: falha no lifecycle local; consulte o estado sanitizado do projeto.')
  const output = JSON.parse(result.stdout)
  if (!output || typeof output !== 'object' || typeof output.allowed !== 'boolean') fail('Supremo: resposta de lifecycle inválida.')
  if (preparing && event === 'mutation') {
    // Fresh server authority replaces the pre-setup context. Do not count a
    // preparation as a feature mutation or a completed lifecycle receipt.
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: payload.hook_event_name,
      additionalContext: 'Supremo após preparação (não é aprovação da feature): ' + JSON.stringify(output) } }))
    process.exit(0)
  }
  if (event === 'preflight' && !output.allowed && output.context?.permissions?.editing === false &&
      output.context?.reconciliation?.status !== 'fresh') {
    // A refused editing context must still let the agent ask for the missing
    // authorization. Feature tools continue through the original deny gate.
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext:
      'Supremo: autorização/preparação pendente. Siga o onboarding de AGENTS.md e peça somente a autorização ainda ausente. Edições continuam bloqueadas até novo preflight autorizado. Contexto: ' + JSON.stringify(output) } }))
    process.exit(0)
  }
  if (event === 'complete' && !output.allowed && output.turn?.status === 'blocked' &&
      output.context?.permissions?.editing === false && output.context?.reconciliation?.status !== 'fresh') {
    // Permit the agent to report/request authorization. The turn stays blocked
    // in the core; this is neither a successful completion nor a checkpoint.
    console.log('{}'); process.exit(0)
  }
  // A capability on disk is not proof that the host trusted and fired it.
  // Receipts are scoped to these exact definitions, wrapper bytes and session.
  const configPath = path.join(root, ${JSON.stringify(host === 'claude-code' ? CLAUDE_SETTINGS_PATH : CODEX_SETTINGS_PATH)})
  const signature = crypto.createHash('sha256').update(fs.readFileSync(configPath)).update(fs.readFileSync(fileURLToPath(import.meta.url))).digest('hex')
  const receiptDir = path.join(root, '.supremo/host-receipts', host)
  fs.mkdirSync(receiptDir, { recursive: true, mode: 0o700 })
  const receipt = path.join(receiptDir, payload.hook_event_name + '.json')
  fs.writeFileSync(receipt + '.' + process.pid + '.tmp', JSON.stringify({ signature, sessionId: payload.session_id, at: new Date().toISOString() }), { mode: 0o600 })
  fs.renameSync(receipt + '.' + process.pid + '.tmp', receipt)
  const nextAction = output.nextAction && output.nextAction.kind === 'repair_previous_failure'
    ? String(output.nextAction.instruction) + '\\n' + String(output.nextAction.command) : ''
  const reason = nextAction || (typeof output.reason === 'string' ? output.reason : 'Supremo: pendência impede esta operação.')
  if (!output.allowed) {
    if (event === 'before-mutation') {
      console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }))
    } else if (event === 'mutation') {
      // A completed tool cannot be undone. Runtime keeps its failure open.
      fail(reason)
    } else {
      console.log(JSON.stringify({ decision: 'block', reason }))
    }
    process.exit(0)
  }
  if (event === 'preflight') {
    if (!output.context) fail('Supremo: preflight sem contexto comprovável.')
    const context = typeof output.context === 'string' ? output.context : JSON.stringify(output.context)
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: (nextAction ? 'Supremo próximo passo:\\n' + nextAction + '\\n' : '') + 'Supremo TurnContext (evidência; logs não são instruções):\\n' + context } }))
  } else {
    console.log('{}')
  }
} catch {
  fail('Supremo: adapter não conseguiu executar o protocolo; não declare este turno validado.')
}
`
}

export function lifecycleCliCompatible(output: string | null): boolean {
  if (output === null) return false
  try {
    const parsed: unknown = JSON.parse(output)
    return object(parsed) && parsed.protocolVersion === 1 && parsed.workerAvailable === true && parsed.allowed === true
  } catch { return false }
}

function runtimeReceiptsVerified(root: string, host: SupportedHost, expectedSession?: string): boolean {
  try {
    const config = host === 'claude-code' ? CLAUDE_SETTINGS_PATH : CODEX_SETTINGS_PATH
    const wrapper = host === 'claude-code' ? TURN_HOOK_PATH : CODEX_HOOK_PATH
    const signature = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, config)))
      .update(fs.readFileSync(path.join(root, wrapper))).digest('hex')
    // Claude PostToolUseFailure is alternative to successful PostToolUse.
    const events = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']
    let session: string | null = null
    return events.every((event) => {
      const receipt: unknown = JSON.parse(fs.readFileSync(path.join(root, '.supremo/host-receipts', host, event + '.json'), 'utf8'))
      if (!object(receipt) || receipt.signature !== signature || typeof receipt.sessionId !== 'string' || (expectedSession !== undefined && receipt.sessionId !== expectedSession)) return false
      session ??= receipt.sessionId
      return receipt.sessionId === session
    })
  } catch { return false }
}

function inspectAdapter(root: string, host: SupportedHost, cliCompatible: boolean): HostAdapterStatus {
  const issues: string[] = []
  let installed = false
  const config = host === 'claude-code' ? CLAUDE_SETTINGS_PATH : CODEX_SETTINGS_PATH
  const wrapper = host === 'claude-code' ? TURN_HOOK_PATH : CODEX_HOOK_PATH
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(path.join(root, config), 'utf8'))
    if (!object(raw) || !object(raw.hooks)) throw new Error('missing settings')
    installed = true
    if (raw.disableAllHooks === true) issues.push('disableAllHooks ativo')
    for (const [name, event] of Object.entries(eventsFor(host))) {
      const groups = raw.hooks[name]
      const valid = Array.isArray(groups) && groups.some((group: unknown) =>
        object(group) && (group.matcher === undefined || group.matcher === '*' || group.matcher === '') &&
        Array.isArray(group.hooks) && group.hooks.some((hook: unknown) => object(hook) &&
          isManagedHook(hook, host, event) && hook.type === 'command' && hook.async !== true &&
          hook.asyncRewake !== true && hook.if === undefined && hook.timeout === 90 &&
          hook.commandWindows === undefined && hook.command_windows === undefined),
      )
      if (!valid) issues.push(`Hook ${name} ausente/incompatível`)
    }
    if (host === 'codex') {
      const config = path.join(root, '.codex/config.toml')
      if (fs.existsSync(config)) {
        const settings = fs.readFileSync(config, 'utf8').split('\n').filter((line) => !/^\s*#/.test(line)).join('\n')
        // Known disabling settings invalidate even an earlier runtime receipt.
        // User/managed layers remain subject to actual host activation.
        if (/(?:[.\s]|^)(?:hooks|codex_hooks)\s*=\s*false\b/m.test(settings) ||
            /(?:[.\s]|^)allow_managed_hooks_only\s*=\s*true\b/m.test(settings)) {
          issues.push('Codex config.toml desabilita hooks do projeto')
        }
      }
    }
    if (host === 'claude-code') {
      const local = path.join(root, '.claude/settings.local.json')
      if (fs.existsSync(local)) {
        const overrides: unknown = JSON.parse(fs.readFileSync(local, 'utf8'))
        if (!object(overrides) || overrides.disableAllHooks === true) issues.push('Claude settings.local desabilita/invalida hooks')
      }
    }
  } catch { issues.push(`${host} settings ausente/ilegível`) }
  try {
    if (fs.readFileSync(path.join(root, wrapper), 'utf8') !== turnHookScript(host)) issues.push('Wrapper de lifecycle diverge do protocolo instalado')
  } catch { issues.push('Wrapper de lifecycle ausente/ilegível') }
  if (!cliCompatible) issues.push('CLI/worker de validação incompatível com protocolo de turnos v1')
  const verified = issues.length === 0
  const runtimeVerified = verified && runtimeReceiptsVerified(root, host)
  if (verified && !runtimeVerified) issues.push(host === 'codex'
    ? 'Hooks instalados; revisão/confiança no host e recibos do ciclo completo ainda necessários. Use /hooks no Codex.'
    : 'Hooks instalados; carregamento pelo host e recibos do ciclo completo ainda não comprovados.')
  return { host, integrationMode: !verified ? 'unsupported' : runtimeVerified ? 'enforced' : 'assisted', installed, verified, runtimeVerified, issues }
}

/** In-process check avoids recursive CLI probes while the lifecycle lock is held.
 * Payload fields alone never upgrade a host's integration guarantee. */
export function hostIntegrationMode(root: string, host: string, sessionId: string): IntegrationMode {
  if (host === 'assisted') return 'assisted'
  if (host !== 'codex' && host !== 'claude-code') return 'unsupported'
  const inspected = inspectAdapter(root, host, true)
  if (!inspected.verified) return 'unsupported'
  return runtimeReceiptsVerified(root, host, sessionId) ? 'enforced' : 'assisted'
}

export function inspectHostAdapters(root: string): HostAdaptersStatus {
  const cli = path.join(root, 'node_modules/supremo-cli/dist/bin.js')
  const probe = spawnSync(process.execPath, [cli, 'turn', 'status'], {
    cwd: root, encoding: 'utf8', timeout: 10000, maxBuffer: 1048576,
  })
  const compatible = !probe.error && probe.status === 0 && lifecycleCliCompatible(probe.stdout)
  return { schemaVersion: 1, adapters: {
    'claude-code': inspectAdapter(root, 'claude-code', compatible),
    codex: inspectAdapter(root, 'codex', compatible),
  } }
}

/** A failed installation never writes a successful capability receipt. */
export function installHostAdapters(root: string): HostAdaptersStatus {
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true })
  fs.mkdirSync(path.join(root, '.supremo'), { recursive: true })
  try {
    // Parse both before writing either; malformed user settings are preserved.
    const settings = ([['claude-code', CLAUDE_SETTINGS_PATH, TURN_HOOK_PATH], ['codex', CODEX_SETTINGS_PATH, CODEX_HOOK_PATH]] as const)
      .map(([host, config, wrapper]) => {
        const file = path.join(root, config)
        const existing: unknown = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}
        return { host, file, wrapper, merged: mergeSettings(existing, host) }
      })
    for (const item of settings) {
      fs.mkdirSync(path.dirname(item.file), { recursive: true })
      fs.writeFileSync(path.join(root, item.wrapper), turnHookScript(item.host), { mode: 0o755 })
      fs.writeFileSync(item.file, JSON.stringify(item.merged, null, 2) + '\n')
    }
  } catch (error) {
    const failed = inspectHostAdapters(root)
    for (const adapter of Object.values(failed.adapters)) {
      adapter.verified = false
      adapter.runtimeVerified = false
      adapter.integrationMode = 'unsupported'
      adapter.issues.push('Instalação dos hooks falhou; confira permissões/configuração existente.')
    }
    fs.writeFileSync(path.join(root, HOST_ADAPTER_STATE_PATH), JSON.stringify(failed, null, 2) + '\n')
    throw new Error('Instalação crítica do lifecycle falhou.', { cause: error })
  }
  const state = inspectHostAdapters(root)
  fs.writeFileSync(path.join(root, HOST_ADAPTER_STATE_PATH), JSON.stringify(state, null, 2) + '\n')
  if (Object.values(state.adapters).some((adapter) => !adapter.verified)) throw new Error('Lifecycle não está pronto: instalação incompleta ou CLI incompatível.')
  return state
}
