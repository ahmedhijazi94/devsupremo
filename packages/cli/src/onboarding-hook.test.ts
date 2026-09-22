import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import { isOnboardingPrepare, onboardingHookParserSource } from './onboarding-hook'

const root = '/work/project'
const origin = 'https://supremo.example.test'
const project = { projectId: '11111111-1111-4111-8111-111111111111', supremoUrl: origin }
const command = `node tools/supremo-cli/dist/bin.js prepare --url ${origin}`
const payload = (text: string, input: Record<string, unknown> = {}) => ({
  cwd: root, tool_name: 'Bash', tool_input: { command: text, ...input },
})

describe('adapter-only onboarding command recognition', () => {
  it.each(['claude-code', 'codex'] as const)('recognizes exact prepare with optional matching %s host', host => {
    expect(isOnboardingPrepare(payload(command), project, host, root)).toBe(true)
    expect(isOnboardingPrepare(payload(`${command} --host ${host}`), project, host, root)).toBe(true)
  })
  it.each(['exec_command', 'functions.exec_command', 'shell_command', 'functions.shell_command'])('recognizes %s cmd input without granting its requested permissions', tool_name => {
    expect(isOnboardingPrepare({ cwd: root, tool_name, tool_input: {
      cmd: command, workdir: root, sandbox_permissions: 'require_escalated', justification: 'Prepare this checkout',
    } }, project, 'codex', root)).toBe(true)
  })
  it('compares canonical issuer, including port and base path', () => {
    const scoped = { ...project, supremoUrl: 'https://supremo.example.test:443/install/' }
    expect(isOnboardingPrepare(payload(`${command}/install/`), scoped, 'codex', root)).toBe(true)
    expect(isOnboardingPrepare(payload(command), scoped, 'codex', root)).toBe(false)
    expect(isOnboardingPrepare(payload(`${command}:8443/install`), scoped, 'codex', root)).toBe(false)
    expect(isOnboardingPrepare(payload(command.replace(origin, 'http://localhost:3000')), {
      ...project, supremoUrl: 'http://localhost:3000/',
    }, 'codex', root)).toBe(true)
  })
  it.each([
    `${command}; echo bad`, `${command} && echo bad`, `${command} || echo bad`, `${command} | cat`,
    `${command} > result`, `${command} &`, `${command}\necho bad`, `${command}\n`, `${command}\r`,
    ` ${command}`, `${command} `, command.replace('node ', 'node\t'),
    `ENV=value ${command}`, `env ${command}`, `sudo ${command}`, `command ${command}`, `exec ${command}`,
    command.replace('node ', 'node --require unsafe.js '), command.replace('node ', '/usr/bin/node '),
    command.replace('tools/', './tools/'), command.replace('tools/', 'node_modules/'),
    command.replace('prepare', 'bootstrap'), `${command} --host claude-code`, `${command} --host codex --force`,
    command.replace(origin, 'https://other.example.test'), command.replace(origin, `${origin}/different`),
    command.replace(origin, 'http://supremo.example.test'), command.replace(origin, 'https://user:password@supremo.example.test'),
    command.replace(origin, `${origin}?x=y`), command.replace(origin, `${origin}#fragment`),
    command.replace(origin, `"${origin}"`), command.replace(origin, `'${origin}'`),
    command.replace(origin, '${ORIGIN}'), command.replace(origin, '$(echo origin)'), command.replace(origin, '`echo origin`'),
    command.replace(origin, `${origin}/%2f`), command.replace(origin, `${origin}/*`),
  ])('rejects shell syntax, extra commands and authority changes: %s', value => {
    expect(isOnboardingPrepare(payload(value), project, 'codex', root)).toBe(false)
  })
  it.each([
    { env: { NODE_OPTIONS: '--require unsafe.js' } }, { shell: 'unsafe-program' }, { workdir: '/work/other' },
    { cwd: '/work/other' }, { cmd: command }, { command: ['node', 'unsafe.js'] }, { extra: 'unrecognized' },
  ])('rejects ambiguous tool inputs and executable/workspace overrides %#', input => {
    expect(isOnboardingPrepare(payload(command, input), project, 'codex', root)).toBe(false)
  })
  it('rejects other tools, nested working directories and malformed project metadata', () => {
    expect(isOnboardingPrepare({ ...payload(command), tool_name: 'Write' }, project, 'codex', root)).toBe(false)
    expect(isOnboardingPrepare({ ...payload(command), cwd: `${root}/child` }, project, 'codex', root)).toBe(false)
    for (const metadata of [null, {}, { ...project, projectId: 'arbitrary' }, { ...project, supremoUrl: 42 }]) {
      expect(isOnboardingPrepare(payload(command), metadata, 'codex', root)).toBe(false)
    }
  })
  it('runs the same parser embedded in a hook without node_modules or imports', () => {
    const context = { URL, result: false, payload: payload(command), project, root }
    vm.runInNewContext(`${onboardingHookParserSource()}\nresult = isOnboardingPrepare(payload, project, 'codex', root)`, context)
    expect(context.result).toBe(true)
    expect(onboardingHookParserSource()).not.toMatch(/permissionDecision|readiness|acceptedAt|require\(|import /)
  })
})
