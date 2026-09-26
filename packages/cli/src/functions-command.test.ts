import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runDatabase } from './database'
import { registerFunctionCommands } from './functions-command'
import { isDatabaseReadCommand } from './database-request'

vi.mock('./database', () => ({ runDatabase: vi.fn() }))
const entrypoint = 'supabase/functions/send-email/index.ts'
let program: Command
beforeEach(() => {
  vi.mocked(runDatabase).mockReset().mockResolvedValue({ queued: true })
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  program = new Command().exitOverride().configureOutput({ writeErr: () => undefined, writeOut: () => undefined })
  registerFunctionCommands(program)
})
afterEach(() => vi.restoreAllMocks())
const run = (args: string[]): Promise<Command> => program.parseAsync(['functions', ...args], { from: 'user' })

describe('functions CLI commands', () => {
  it('defaults deployment to development with JWT verification enabled', async () => {
    await run(['deploy', 'send-email', '--entrypoint', entrypoint])
    expect(runDatabase).toHaveBeenCalledExactlyOnceWith('functions-deploy', process.cwd(), {
      environment: 'development', slug: 'send-email', entrypoint, files: [], verifyJwt: true,
    })
  })

  it('accepts production only when explicitly selected', async () => {
    await run(['deploy', 'send-email', '--entrypoint', entrypoint, '--environment', 'production'])
    expect(runDatabase).toHaveBeenCalledWith('functions-deploy', process.cwd(), expect.objectContaining({ environment: 'production', verifyJwt: true }))
  })

  it('disables JWT verification only with the explicit flag and preserves selected files/import map', async () => {
    await run(['deploy', 'send-email', '--entrypoint', entrypoint, '--file', 'src/email.ts', '--file', 'src/layout.ts',
      '--import-map', 'supabase/functions/send-email/deno.json', '--no-verify-jwt'])
    expect(runDatabase).toHaveBeenCalledExactlyOnceWith('functions-deploy', process.cwd(), {
      environment: 'development', slug: 'send-email', entrypoint, files: ['src/email.ts', 'src/layout.ts'],
      importMap: 'supabase/functions/send-email/deno.json', verifyJwt: false,
    })
  })

  it.each([
    { args: ['list'], operation: 'functions-list', options: { environment: 'development' } },
    { args: ['status', 'send-email'], operation: 'functions-status', options: { environment: 'development', slug: 'send-email' } },
    { args: ['hook-status'], operation: 'functions-hook-status', options: { environment: 'development' } },
    { args: ['hook-configure', 'send-email'], operation: 'functions-hook-configure',
      options: { environment: 'development', slug: 'send-email', secretName: 'AUTH_SEND_EMAIL_HOOK_SECRET' } },
  ])('routes $operation through the daemon', async ({ args, operation, options }) => {
    await run(args)
    expect(runDatabase).toHaveBeenCalledExactlyOnceWith(operation, process.cwd(), options)
    expect(console.log).toHaveBeenCalledWith('{"queued":true}')
  })

  it.each([
    ['deploy', 'send-email'],
    ['deploy', 'send-email', '--entrypoint', entrypoint, '--environment', 'unknown'],
    ['deploy', 'send-email', '--entrypoint', entrypoint, '--file', '.env.local'],
    ['deploy', 'send-email', '--entrypoint', entrypoint, '--token', 'fixture-token'],
    ['hook-configure', 'send-email', '--secret-name', 'SUPABASE_SERVICE_ROLE_KEY'],
    ['hook-configure', 'send-email', '--secret', 'fixture-signing-secret'],
  ])('rejects invalid arguments without queuing an operation: %j', async (...args) => {
    await expect(run(args)).rejects.toThrow()
    expect(runDatabase).not.toHaveBeenCalled()
  })
})

describe('function diagnostics during local recovery', () => {
  it.each([
    'supremo functions list', 'supremo functions status send-email', 'supremo functions hook-status',
    'supremo functions status send-email --environment development', 'supremo functions list --environment production',
    'node tools/supremo-cli/dist/bin.js functions hook-status',
    'node node_modules/supremo-cli/dist/bin.js functions list',
  ])('allows the literal read command %s', command => {
    expect(isDatabaseReadCommand(command)).toBe(true)
  })

  it.each([
    'supremo functions deploy send-email --entrypoint supabase/functions/send-email/index.ts',
    'supremo functions hook-configure send-email', 'supremo functions status',
    'supremo functions list --environment unknown', 'supremo functions status ../foreign',
    'supremo functions list --expected-ref foreign', 'supremo functions hook-status --secret fixture',
    'supremo functions status send-email && echo unsafe', 'supremo functions list; echo unsafe',
    'supremo functions status $(cat .env.local)',
  ])('refuses writes and composed or injected read commands: %s', command => {
    expect(isDatabaseReadCommand(command)).toBe(false)
  })
})
