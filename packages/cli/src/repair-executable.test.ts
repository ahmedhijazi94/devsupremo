import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isRunnerLaunchUnavailable, RepairRunnerUnavailableError, resolveRepairExecutable } from './repair-executable'

const folders: string[] = []
afterEach(() => { for (const dir of folders.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })

describe('repair executable availability', () => {
  it('accepts executable files from absolute PATH entries without executing them', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supremo-repair-executable-')); folders.push(dir)
    const binary = path.join(dir, 'codex')
    fs.writeFileSync(binary, 'This fixture must never be executed.', { mode: 0o600 })
    expect(() => resolveRepairExecutable('codex', { searchPath: dir, platform: 'linux' })).toThrow(RepairRunnerUnavailableError)
    fs.chmodSync(binary, 0o700)
    expect(resolveRepairExecutable('codex', { searchPath: `.:relative:${dir}`, platform: 'linux' })).toBe(binary)
  })
  it('uses the installed desktop bundle when the daemon PATH has no Codex', () => {
    const binary = '/Applications/ChatGPT.app/Contents/Resources/codex'
    const isExecutable = vi.fn((file: string) => file === binary)
    expect(resolveRepairExecutable('codex', { searchPath: '/usr/bin', platform: 'darwin', homeDir: '/Users/fixture', isExecutable })).toBe(binary)
    expect(isExecutable.mock.calls.map(call => call[0])).toEqual([
      '/usr/bin/codex', '/Applications/Codex.app/Contents/Resources/codex', binary,
    ])
  })
  it('prefers PATH and supports a user Applications installation', () => {
    const isExecutable = (file: string): boolean => file === '/custom/bin/codex' || file === '/Users/fixture/Applications/Codex.app/Contents/Resources/codex'
    expect(resolveRepairExecutable('codex', { searchPath: '/custom/bin', platform: 'darwin', homeDir: '/Users/fixture', isExecutable })).toBe('/custom/bin/codex')
    expect(resolveRepairExecutable('codex', { searchPath: '', platform: 'darwin', homeDir: '/Users/fixture', isExecutable }))
      .toBe('/Users/fixture/Applications/Codex.app/Contents/Resources/codex')
  })
  it('does not select project-local PATH entries or a different provider', () => {
    const isExecutable = vi.fn(() => false)
    expect(() => resolveRepairExecutable('claude', { searchPath: '.:relative:/usr/bin', platform: 'darwin', isExecutable })).toThrow('PATH do daemon')
    expect(isExecutable.mock.calls).toEqual([['/usr/bin/claude']])
  })
  it('recognizes only executable launch failures, not missing output files or model failures', () => {
    expect(isRunnerLaunchUnavailable(new RepairRunnerUnavailableError('codex'))).toBe(true)
    expect(isRunnerLaunchUnavailable(Object.assign(new Error('launch'), { code: 'EACCES', syscall: 'spawn codex' }))).toBe(true)
    expect(isRunnerLaunchUnavailable(Object.assign(new Error('output'), { code: 'ENOENT', syscall: 'open' }))).toBe(false)
    expect(isRunnerLaunchUnavailable(new Error('model failed'))).toBe(false)
    expect(isRunnerLaunchUnavailable('spawn codex ENOENT')).toBe(false)
  })
})
