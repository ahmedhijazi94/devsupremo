import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerDataDeleteCommands } from './data-delete-command'
import { isDatabaseReadCommand, parseDatabaseOptions } from './database-request'
import { runDatabase } from './database'

vi.mock('./database', () => ({ runDatabase: vi.fn() }))
const token = 'signed-plan-fixture-'.repeat(5)
const targets = [{ table: 'memberships', key: { org_id: 'company-requested', user_id: 'owner-requested' } }, { table: 'orgs', key: { id: 'company-requested' } }]
let cwd: string, program: Command
beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'supremo-delete-command-'))
  fs.mkdirSync(path.join(cwd, '.supremo'))
  fs.writeFileSync(path.join(cwd, 'targets.json'), JSON.stringify(targets))
  fs.writeFileSync(path.join(cwd, 'plan.json'), JSON.stringify({ data: { planToken: token } }))
  vi.spyOn(process, 'cwd').mockReturnValue(cwd)
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  vi.mocked(runDatabase).mockReset().mockResolvedValue({ data: { planToken: token } })
  program = new Command().exitOverride().configureOutput({ writeErr: () => undefined, writeOut: () => undefined })
  registerDataDeleteCommands(program)
})
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(cwd, { recursive: true, force: true }) })
const run = (args: string[]): Promise<Command> => program.parseAsync(['data', ...args], { from: 'user' })

describe('point deletion commands', () => {
  it('queues exact child-first keys for inspection, optionally saving the response privately', async () => {
    await run(['delete-plan', '--file', 'targets.json', '--environment', 'development', '--output', '.supremo/delete-plan.json'])
    expect(runDatabase).toHaveBeenCalledExactlyOnceWith('data-delete-plan', cwd, { environment: 'development', targets })
    expect(JSON.parse(fs.readFileSync(path.join(cwd, '.supremo/delete-plan.json'), 'utf8'))).toEqual({ data: { planToken: token } })
    expect(fs.statSync(path.join(cwd, '.supremo/delete-plan.json')).mode & 0o777).toBe(0o600)
  })
  it('queues a saved token and the actual authorization once, never a local SQL operation', async () => {
    await run(['delete-apply', '--plan-file', 'plan.json', '--authorization', 'Usuário solicitou excluir esta empresa e seu vínculo.', '--environment', 'development'])
    expect(runDatabase).toHaveBeenCalledExactlyOnceWith('data-delete-apply', cwd, {
      environment: 'development', planToken: token, authorization: 'Usuário solicitou excluir esta empresa e seu vínculo.',
    })
  })
  it('never overwrites a plan/source or writes outside the project', async () => {
    const before = fs.readFileSync(path.join(cwd, 'plan.json'), 'utf8')
    await expect(run(['delete-plan', '--file', 'targets.json', '--environment', 'development', '--output', 'plan.json'])).rejects.toThrow()
    expect(fs.readFileSync(path.join(cwd, 'plan.json'), 'utf8')).toBe(before)
    await expect(run(['delete-plan', '--file', 'targets.json', '--environment', 'development', '--output', '../outside.json'])).rejects.toThrow('dentro do projeto')
    fs.writeFileSync(path.join(cwd, '.supremo/saved-plan.json'), before)
    await expect(run(['delete-plan', '--file', 'targets.json', '--environment', 'development', '--output', '.supremo/saved-plan.json'])).rejects.toThrow()
    expect(fs.readFileSync(path.join(cwd, '.supremo/saved-plan.json'), 'utf8')).toBe(before)
  })
  it.each([
    ['delete-plan', '--file', 'targets.json'],
    ['delete-plan', '--file', 'targets.json', '--environment', 'production'],
    ['delete-plan', '--file', 'targets.json', '--environment', 'development', '--sql', 'delete from public.orgs'],
    ['delete-apply', '--plan-file', 'plan.json', '--environment', 'development'],
    ['delete-apply', '--plan-file', 'plan.json', '--authorization', 'yes', '--environment', 'development'],
    ['delete-apply', '--plan-file', 'plan.json', '--authorization', 'Solicitado pelo usuário.', '--environment', 'production'],
  ])('rejects incomplete or broadened requests: %j', async (...args) => {
    await expect(run(args)).rejects.toThrow()
    expect(runDatabase).not.toHaveBeenCalled()
  })
  it('rejects symlinked files and parent directories without queuing', async () => {
    fs.symlinkSync(path.join(cwd, 'targets.json'), path.join(cwd, 'linked.json'))
    fs.symlinkSync(cwd, path.join(cwd, 'linked-parent'))
    for (const file of ['linked.json', 'linked-parent/targets.json']) {
      await expect(run(['delete-plan', '--file', file, '--environment', 'development'])).rejects.toThrow()
    }
    expect(runDatabase).not.toHaveBeenCalled()
  })
  it('rejects malformed or unbounded files and blanket deletion targets', async () => {
    for (const content of ['{', JSON.stringify([{ table: 'orgs', key: {} }]), JSON.stringify(Array(26).fill(targets[1])), ' '.repeat(256 * 1024 + 1)]) {
      fs.writeFileSync(path.join(cwd, 'targets.json'), content)
      await expect(run(['delete-plan', '--file', 'targets.json', '--environment', 'development'])).rejects.toThrow()
    }
    expect(runDatabase).not.toHaveBeenCalled()
  })
  it('refuses raw token strings instead of the saved response object', async () => {
    fs.writeFileSync(path.join(cwd, 'plan.json'), JSON.stringify(token))
    await expect(run(['delete-apply', '--plan-file', 'plan.json', '--authorization', 'Excluir os registros solicitados.', '--environment', 'development'])).rejects.toThrow()
    expect(runDatabase).not.toHaveBeenCalled()
  })
  it('accepts a valid large saved response while forwarding only its bounded token', async () => {
    const largeToken = 'x'.repeat(500_000)
    const largeTargets = Array.from({ length: 20 }, (_, index) => ({ table: 'orgs',
      key: Object.fromEntries(Array.from({ length: 8 }, (_, column) => [`key_${column}`, `${index}:${'x'.repeat(990)}`])),
    }))
    fs.writeFileSync(path.join(cwd, 'plan.json'), JSON.stringify({ data: { planToken: largeToken, targets: largeTargets } }))
    await run(['delete-apply', '--plan-file', 'plan.json', '--authorization', 'Excluir os registros solicitados.', '--environment', 'development'])
    expect(runDatabase).toHaveBeenCalledExactlyOnceWith('data-delete-apply', cwd, { environment: 'development', planToken: largeToken, authorization: 'Excluir os registros solicitados.' })
  })
})

describe('deletion command boundaries', () => {
  it.each([
    'supremo data delete-plan --file .supremo/targets.json --environment development',
    'supremo data delete-plan --file targets.json --output .supremo/delete-plan.json --environment development',
    'node tools/supremo-cli/dist/bin.js data delete-plan --environment development --file targets.json',
  ])('allows only the planning diagnostic during recovery: %s', command => expect(isDatabaseReadCommand(command)).toBe(true))
  it.each([
    'supremo data delete-apply --plan-file plan.json --authorization "Exclua os dados" --environment development',
    'supremo data delete-plan --file targets.json',
    'supremo data delete-plan --file targets.json --environment production',
    'supremo data delete-plan --file targets.json --file others.json --environment development',
    'supremo data delete-plan --file targets.json --environment development --sql delete',
    'supremo data delete-plan --file $(cat key) --environment development',
    'supremo data delete-plan --file targets.json --environment development; echo unsafe',
  ])('does not classify writes or composition as reads: %s', command => expect(isDatabaseReadCommand(command)).toBe(false))
  it('accepts only bounded typed options without SQL, credentials or target overrides', () => {
    expect(parseDatabaseOptions('data-delete-plan', { environment: 'development', targets })).toEqual({ environment: 'development', targets })
    for (const extra of [{ sql: 'delete from orgs' }, { expectedRef: 'foreign' }, { deviceSecret: 'wrong' }, { cascade: true }]) {
      expect(() => parseDatabaseOptions('data-delete-plan', { environment: 'development', targets, ...extra })).toThrow()
    }
    expect(() => parseDatabaseOptions('data-delete-apply', { environment: 'development', planToken: token, authorization: 'Pedido explícito.', targets })).toThrow()
  })
})
